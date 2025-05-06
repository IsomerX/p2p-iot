// Save as src/target/directConnect.ts
import * as dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
// Fix the WebSocket import
import WebSocket from "ws";
import {
  DEFAULT_WEBSOCKET_PORT,
  MESSAGE_TYPES,
  COMMAND_TYPES,
} from "../shared/constants";
import { DeviceType } from "../shared/types";
import { createBaseMessage, createLogger } from "../shared/utils";

// Setup logger
const logger = createLogger("DirectConnect");

// Controller address - this should match your controller's IP
const CONTROLLER_IP = "192.168.1.40"; // Your controller's IP
const CONTROLLER_PORT = 8080; // Your controller's WebSocket port

// Create a device ID and name
const deviceId = uuidv4();
const deviceName = `DirectConnect-${Date.now().toString(36)}`;

logger.info(
  `Starting direct connection to ${CONTROLLER_IP}:${CONTROLLER_PORT}`,
);
logger.info(`Device ID: ${deviceId}`);
logger.info(`Device Name: ${deviceName}`);

// Create WebSocket connection
const ws = new WebSocket(`ws://${CONTROLLER_IP}:${CONTROLLER_PORT}`);

ws.on("open", () => {
  logger.info("Connected to controller!");

  // Send registration message
  const registrationMessage = {
    ...createBaseMessage(MESSAGE_TYPES.REGISTER, deviceId, DeviceType.TARGET),
    data: {
      deviceInfo: {
        id: deviceId,
        name: deviceName,
        ip: "127.0.0.1",
        type: DeviceType.TARGET,
        supportedCommands: [
          COMMAND_TYPES.ARROW_LEFT,
          COMMAND_TYPES.ARROW_RIGHT,
        ],
      },
    },
  };

  ws.send(JSON.stringify(registrationMessage));
  logger.info("Sent registration message");
});

ws.on("message", (data) => {
  try {
    const message = JSON.parse(data.toString());
    logger.info(`Received message: ${message.type}`);
    console.log(JSON.stringify(message, null, 2));

    // Handle specific message types if needed
    if (message.type === MESSAGE_TYPES.COMMAND) {
      logger.info(`Received command: ${message.data.commandType}`);
    }
  } catch (error) {
    logger.error("Error parsing message", error);
  }
});

ws.on("error", (error) => {
  logger.error("WebSocket error", error);
});

ws.on("close", () => {
  logger.info("Disconnected from controller");
});

// Keep the process running
process.on("SIGINT", () => {
  logger.info("Shutting down...");
  ws.close();
  process.exit(0);
});
