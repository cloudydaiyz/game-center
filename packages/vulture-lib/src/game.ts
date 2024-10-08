// Game management functions

import jwt from "jsonwebtoken";
import { AccessCredentials, CreateGameConfirmation, GameSchema, GameSettings, PlayerRole, PublicGameSchema, TaskSchema, UpdateGameStateConfirmation, UserRole, UserToken } from "./types";
import { ObjectId, SetFields, UpdateFilter, WithId } from "mongodb";
import { getGameColl, getPlayerColl, getClient } from "./mongodb";
import { verifyToken } from "./auth";
import assert from "assert";
import { ACCESS_TOKEN_KEY, ADMIN_CODES, MAX_ADMINS, MAX_GAMES, REFRESH_TOKEN_KEY, SCHEDULER_GROUP_NAME, SCHEDULER_ROLE_ARN } from "./constants";
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand, ResourceNotFoundException } from "@aws-sdk/client-scheduler";
import { APIGatewayProxyEventV2 } from "aws-lambda";

/**
 * Upgrades user credentials to game-based credentials
 * @param token The token of the user
 * @param gameId The game from which to update the credentials
 * @param role The role of the user within the game
 * @returns Updated access and refresh tokens based on the game specified
 */
function upgradeCredentials(token: UserToken, gameId: ObjectId, role: UserRole): AccessCredentials {
    const creds: UserToken = {
        userid: token.userid,
        username: token.username
    }
    creds.gameId = gameId;
    creds.role = role;

    // Create new tokens with upgraded credentials to return
    const access_token = jwt.sign(
        creds, 
        ACCESS_TOKEN_KEY, 
        { expiresIn: "15min" }
    );
    const refresh_token = jwt.sign(
        creds, 
        REFRESH_TOKEN_KEY, 
        { expiresIn: "3hr" }
    );

    return {
        accessToken: access_token,
        refreshToken: refresh_token
    };
}

// Creates a new game with the user specified in the token, the specified game settings and tasks
export async function createGame(token: string, settings: GameSettings, tasks: TaskSchema[]): Promise<CreateGameConfirmation> {
    const games = await getGameColl().find().toArray();
    assert(games.length < MAX_GAMES, "Max games reached");

    const decodedToken = jwt.verify(token, ACCESS_TOKEN_KEY) as UserToken;
    tasks.forEach(t => t._id = new ObjectId());
    const taskids = tasks.map(t => t._id.toString());

    // Set the end time based on the start time and duration
    settings.endTime = 0;
    if(settings.duration) settings.endTime = settings.startTime + settings.duration;

    const res = await getGameColl().insertOne({
        tasks: tasks,
        settings: settings,
        state: settings.minPlayers == 0 ? "ready" : "not ready",
        players: [],
        admins: [],
        host: decodedToken.username
    });
    assert(res.acknowledged && res.insertedId != null, "Create operation unsuccessful");

    const creds = upgradeCredentials(decodedToken, res.insertedId, "host");
    return { creds: creds, gameid: res.insertedId.toString(), taskids: taskids } as CreateGameConfirmation;
}

// Joins a game with the given game ID, role, and admin code
export async function joinGame(token: string, rawGameId: string, role: PlayerRole, code?: string): Promise<AccessCredentials> {
    const gameId = new ObjectId(rawGameId);

    // Ensure the code for an admin role is correct
    const adminCodes = ADMIN_CODES;
    assert(role != "admin" || code && adminCodes && adminCodes.includes(code),
            "Invalid admin creds");

    // Decode the token and get the game to verify the player doesn't already exist
    const decodedToken = jwt.verify(token, ACCESS_TOKEN_KEY) as UserToken;
    const game = await getGameColl().findOne({ _id: gameId });
    assert(game, "Invalid game ID");
    assert(decodedToken.username != game.host 
        && !game.players.includes(decodedToken.username) 
        && !game.admins.includes(decodedToken.username), 
        "User already in game");
    assert(role != "player" || game.players.length < game.settings.maxPlayers, "Maximum player capacity reached for this game");
    assert(role != "admin" || game.admins.length < MAX_ADMINS, "Maximum admin capacity reached for this game");
    assert(role == "admin" || game.state != "ended", "This game has already ended; unable to join");

    // Start a MongoDB client session to begin a transaction
    const session = getClient().startSession();
    await session.withTransaction(async () => {

        // Decide whether to update the game's players or admins with based on the specified role
        const update: UpdateFilter<GameSchema> = {};
        let toAdd: SetFields<GameSchema>;
        if(role == "admin") {
            toAdd = { "admins": decodedToken.username };
        } else {
            toAdd = { "players": decodedToken.username };

            // Insert a new player
            const playerRes = await getPlayerColl().insertOne({
                gameId: gameId,
                username: decodedToken.username,
                points: 0,
                tasksSubmitted: [],
                done: game.settings.numRequiredTasks == 0 ? true : false
            });
            assert(playerRes.acknowledged && playerRes.insertedId != null, "Create operation unsuccessful");

            // If there's enough players after this operation, update the game's state
            if(game.state == "not ready" && game.players.length == game.settings.minPlayers - 1) {
                update.$set = { "state": "ready" };
            }
        }
        update.$addToSet = toAdd;

        // Update the game's players (and admins if the new player is an admin)
        const gameRes = await getGameColl().updateOne({ _id: gameId }, update);
        assert(gameRes.acknowledged && gameRes.modifiedCount == 1, "Operation unsuccessful");
    }).then(() => session.endSession());

    return upgradeCredentials(decodedToken, gameId, role);
}

// Returns the information about a game; only a host or admin can see
export async function getGame(token: string, rawGameId: string): Promise<WithId<GameSchema>> {
    const gameId = new ObjectId(rawGameId);
    verifyToken(token, gameId, ["host", "admin"]);

    const game = await getGameColl().findOne({ _id: gameId });
    assert(game, "Invalid game ID");

    return game;
}

// Returns the public information about a game
export async function getPublicGame(rawGameId: string): Promise<PublicGameSchema> {
    const gameId = new ObjectId(rawGameId);
    const game = await getGameColl().findOne({ _id: gameId });
    assert(game, "Invalid game");

    const publicGame: PublicGameSchema = {
        settings: game.settings,
        numTasks: game.tasks.length,
        state: game.state,
        host: game.host,
        admins: game.admins,
        players: game.players
    };
    return publicGame;
}

// Returns the public information about all games
export async function listPublicGames(): Promise<PublicGameSchema[]> {
    const games = await getGameColl().find();
    const publicGames: PublicGameSchema[] = [];

    for(const game of await games.toArray()) {
        publicGames.push({
            settings: game.settings,
            numTasks: game.tasks.length,
            state: game.state,
            host: game.host,
            admins: game.admins,
            players: game.players
        });
    }
    return publicGames;
}

// Removes the player's information about the specified game; must be a player or admin
export async function leaveGame(token: string, rawGameId: string): Promise<void> {
    const gameId = new ObjectId(rawGameId);
    const decodedToken = verifyToken(token, gameId, ["player", "admin"]);

    const result = await getGameColl().updateOne({ _id: gameId }, 
        { $pull: { players: decodedToken.username } });
    assert(result.acknowledged && result.modifiedCount == 1, "No player removed");
}

// Begins the specified game if it's ready
export async function startGame(token: string, rawGameId: string, gameFunctionArn?: string, 
    stopGameEvent?: APIGatewayProxyEventV2): Promise<UpdateGameStateConfirmation> {
    const gameId = new ObjectId(rawGameId);
    verifyToken(token, gameId, ["host", "admin"]);
    
    // Ensure the game is in the ready state
    const game = await getGameColl().findOne({ _id: gameId });
    assert(game, "Invalid game ID");
    assert(game.state == "ready", "Invalid game state");

    // Update the start time and end time based on the game's duration
    const currentTime = Date.now();
    const endTime = game.settings.duration == 0 ? 0 : currentTime + game.settings.duration * 1000;
    const result = await getGameColl().updateOne({ _id: gameId }, {
        $set: {
            state: "running",
            "settings.startTime": currentTime,
            "settings.endTime": endTime
        }
    });
    assert(result.acknowledged && result.modifiedCount == 1, "Failed to start game");

    // Sets up an EventBridge timer to end the game at the specified time
    if(game.settings.duration > 0) {
        assert(gameFunctionArn, "gameFunctionArn must be specified if the game has a duration > 0.");
        assert(stopGameEvent, "stopGameEvent must be specified if the game has a duration > 0.");
        stopGameEvent.headers.source = "scheduler";

        console.log("beginning scheduler");
        const schedulerClient = new SchedulerClient();
        const command = new CreateScheduleCommand({
            Name: `end-game-${rawGameId}`,
            ScheduleExpression: `at(${(new Date(endTime)).toISOString().substring(0, 19)})`,
            Target: {
                Arn: gameFunctionArn,
                RoleArn: SCHEDULER_ROLE_ARN,
                Input: JSON.stringify(stopGameEvent)
            },
            GroupName: SCHEDULER_GROUP_NAME,
            FlexibleTimeWindow: {
                Mode: "OFF"
            },
            ActionAfterCompletion: "DELETE"
        });
        const response = await schedulerClient.send(command);
        schedulerClient.destroy();
        console.log("ended scheduler");
        console.log("scheduler response: " + response.ScheduleArn);
        game.stopScheduleArn = response.ScheduleArn;
    }

    return {
        startTime: currentTime,
        endTime: endTime
    };
}

// Stops the specified game if it's currently running
export async function stopGame(token: string, rawGameId: string, fromSchedule?: boolean): Promise<UpdateGameStateConfirmation> {
    const gameId = new ObjectId(rawGameId);
    verifyToken(token, gameId, ["host", "admin"]);

    // Ensure the game is in the ready state
    const game = await getGameColl().findOne({ _id: gameId });
    assert(game, "Invalid game ID");
    assert(game.state == "running", "Invalid game state");

    const currentTime = Date.now();
    const result = await getGameColl().updateOne({ _id: gameId }, {
        $set: {
            state: "ended",
            "settings.endTime": currentTime
        }
    });
    assert(result.acknowledged && result.modifiedCount == 1, "Failed to end game");

    // Delete the associated scheduler if the request wasn't from the scheduler
    if(!fromSchedule) {
        try {
            const schedulerClient = new SchedulerClient();
            const command = new DeleteScheduleCommand({
                Name: `end-game-${rawGameId}`,
                GroupName: SCHEDULER_GROUP_NAME
            });
            const response = await schedulerClient.send(command);
            console.log(response);
            console.log("deleted scheduler");
            console.log("scheduler response: " + response.$metadata);
            schedulerClient.destroy();
        } catch(e) {

            // Even if there's an error here, either way we were able to stop the game
            // successfully, so just log the results
            if(e instanceof ResourceNotFoundException) {
                console.log("No schedule to destroy");
            } else {
                console.log("Unable to destroy schedule, reason: " + (e as Error).message);
            }
        }
    }

    return {
        startTime: game.settings.startTime,
        endTime: currentTime
    };
}

// Restarts the speciifed game
export async function restartGame(token: string, rawGameId: string): Promise<CreateGameConfirmation> {
    const gameId = new ObjectId(rawGameId);
    verifyToken(token, gameId, ["host", "admin"]);

    // Ensure the game exists and has ended
    const game = await getGameColl().findOne({ _id: gameId });
    assert(game, "Invalid game ID");
    assert(game.state == "ended", "Game hasn't ended, unable to restart");

    // Create a new game with the same settings and tasks as the current game
    return createGame(token, game.settings, game.tasks);
}

// Deletes the specified game
export async function deleteGame(token: string, rawGameId: string): Promise<GameSchema> {
    const gameId = new ObjectId(rawGameId);
    verifyToken(token, gameId, ["host", "admin"]);

    const game = await getGameColl().findOne({ _id: gameId });
    assert(game, "Invalid game ID");
    assert(game.state != "running", "Game is still running, unable to delete");

    const session = getClient().startSession();
    await session.withTransaction(async () => {

        // Delete game
        const gameDeletion = await getGameColl().deleteOne({ _id: gameId });
        assert(gameDeletion.acknowledged && gameDeletion.deletedCount == 1, "Unable to complete delete operation");

        // Delete players associated with the game
        const playerDeletion = await getPlayerColl().deleteMany({ gameId: gameId });
        assert(playerDeletion.acknowledged, "Unable to complete delete operation");
    }).then(() => session.endSession());

    return game;
}