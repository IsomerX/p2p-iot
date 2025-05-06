import { v4 as uuidv4 } from "uuid";
import * as dotenv from "dotenv";
import NetworkScanner from "./networkScanner";
import { DeviceRegistry } from "./deviceRegistry";
import ControlServer from "./controlServer";
import {
  COMMAND_TYPES,
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_WEBSOCKET_PORT,
} from "../shared/constants";
import { createLogger } from "../shared/utils";

// Load environment variables
dotenv.config();

const logger = createLogger("ControllerApp");

/**
 * Main controller application class
 */
class ControllerApp {
  private readonly controllerId: string;
  private readonly controllerName: string;
  private readonly deviceRegistry: DeviceRegistry;
  private readonly networkScanner: NetworkScanner;
  private readonly controlServer: ControlServer;
  private isRunning: boolean = false;

  constructor() {
    // Initialize controller ID and name
    this.controllerId = process.env.CONTROLLER_ID || uuidv4();
    this.controllerName =
      process.env.CONTROLLER_NAME ||
      `ArrowController-${this.controllerId.substring(0, 8)}`;

    // Initialize device registry
    this.deviceRegistry = new DeviceRegistry();

    // Initialize network scanner
    this.networkScanner = new NetworkScanner({
      controllerId: this.controllerId,
      controllerName: this.controllerName,
      supportedCommands: Object.values(COMMAND_TYPES),
      controlPort: Number(process.env.WEBSOCKET_PORT) || DEFAULT_WEBSOCKET_PORT,
      discoveryPort:
        Number(process.env.DISCOVERY_PORT) || DEFAULT_CONTROLLER_PORT,
    });

    // Initialize control server
    this.controlServer = new ControlServer({
      controllerId: this.controllerId,
      deviceRegistry: this.deviceRegistry,
      port: Number(process.env.WEBSOCKET_PORT) || DEFAULT_WEBSOCKET_PORT,
    });

    // Set up event handlers
    this.setupEventHandlers();
  }

  /**
   * Start the controller application
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Controller application is already running");
      return;
    }

    logger.info(
      `Starting controller application: ${this.controllerName} (${this.controllerId})`,
    );

    try {
      // Start control server
      await this.controlServer.start();

      // Start network scanner
      this.networkScanner.start();

      this.isRunning = true;
      logger.info("Controller application started successfully");

      // Log startup information
      this.logStartupInfo();
    } catch (error) {
      logger.error("Error starting controller application", error);
      throw error;
    }
  }

  /**
   * Stop the controller application
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn("Controller application is not running");
      return;
    }

    logger.info("Stopping controller application");

    try {
      // Stop network scanner
      this.networkScanner.stop();

      // Stop control server
      await this.controlServer.stop();

      this.isRunning = false;
      logger.info("Controller application stopped successfully");
    } catch (error) {
      logger.error("Error stopping controller application", error);
      throw error;
    }
  }

  /**
   * Send an arrow command to a device
   */
  public async sendArrowCommand(
    deviceId: string,
    direction: "left" | "right",
    options: { repeat?: number; holdTime?: number } = {},
  ): Promise<boolean> {
    try {
      return await this.controlServer.sendArrowCommand(
        deviceId,
        direction,
        options,
      );
    } catch (error) {
      logger.error(`Error sending arrow command to device: ${deviceId}`, error);
      return false;
    }
  }

  /**
   * Get all registered devices
   */
  public getAllDevices() {
    return this.deviceRegistry.getAllDevices();
  }

  /**
   * Get connected devices
   */
  public getConnectedDevices() {
    return this.deviceRegistry.getConnectedDevices();
  }

  /**
   * Get paired devices
   */
  public getPairedDevices() {
    return this.deviceRegistry.getPairedDevices();
  }

  /**
   * Set up event handlers
   */
  private setupEventHandlers() {
    // Network scanner events
    this.networkScanner.on("newDevice", (device) => {
      logger.info(
        `New device discovered: ${device.ip} (${device.mac || "unknown MAC"})`,
      );
    });

    this.networkScanner.on("deviceRegistration", ({ ip, deviceInfo }) => {
      logger.info(
        `Device registration request from ${ip}: ${deviceInfo.name} (${deviceInfo.id})`,
      );
    });

    this.networkScanner.on("deviceLost", (device) => {
      logger.info(`Device lost: ${device.ip} (${device.mac || "unknown MAC"})`);
    });

    // Device registry events
    this.deviceRegistry.on("deviceRegistered", (device) => {
      logger.info(
        `Device registered: ${device.deviceInfo.name} (${device.deviceInfo.id})`,
      );
    });

    this.deviceRegistry.on("deviceConnected", (device) => {
      logger.info(
        `Device connected: ${device.deviceInfo.name} (${device.deviceInfo.id})`,
      );
    });

    this.deviceRegistry.on("deviceDisconnected", (device) => {
      logger.info(
        `Device disconnected: ${device.deviceInfo.name} (${device.deviceInfo.id})`,
      );
    });

    this.deviceRegistry.on("devicePaired", (device) => {
      logger.info(
        `Device paired: ${device.deviceInfo.name} (${device.deviceInfo.id})`,
      );
    });

    this.deviceRegistry.on("deviceUnpaired", (device) => {
      logger.info(
        `Device unpaired: ${device.deviceInfo.name} (${device.deviceInfo.id})`,
      );
    });

    // Control server events
    this.controlServer.on("connection", ({ connectionId, ip }) => {
      logger.info(`New connection: ${connectionId} from ${ip}`);
    });

    this.controlServer.on("connectionClosed", ({ connectionId, deviceId }) => {
      logger.info(
        `Connection closed: ${connectionId}${deviceId ? ` (Device: ${deviceId})` : ""}`,
      );
    });

    this.controlServer.on(
      "commandResult",
      ({ device, commandType, success, error }) => {
        if (success) {
          logger.info(
            `Command ${commandType} executed successfully on device: ${device.deviceInfo.name}`,
          );
        } else {
          logger.warn(
            `Command ${commandType} failed on device: ${device.deviceInfo.name} - ${error}`,
          );
        }
      },
    );

    this.controlServer.on("error", (error) => {
      logger.error("Control server error", error);
    });
  }

  /**
   * Log startup information
   */
  private logStartupInfo() {
    const localIp = require("os").networkInterfaces();
    let ipAddresses: string[] = [];

    // Collect all IPv4 addresses
    Object.keys(localIp).forEach((interfaceName) => {
      localIp[interfaceName].forEach((iface) => {
        if (iface.family === "IPv4" && !iface.internal) {
          ipAddresses.push(iface.address);
        }
      });
    });

    logger.info("=================================================");
    logger.info("Arrow Control System Controller");
    logger.info("=================================================");
    logger.info(`Controller ID:    ${this.controllerId}`);
    logger.info(`Controller Name:  ${this.controllerName}`);
    logger.info(`IP Addresses:     ${ipAddresses.join(", ")}`);
    logger.info(
      `WebSocket Port:   ${process.env.WEBSOCKET_PORT || DEFAULT_WEBSOCKET_PORT}`,
    );
    logger.info(
      `Discovery Port:   ${process.env.DISCOVERY_PORT || DEFAULT_CONTROLLER_PORT}`,
    );
    logger.info("=================================================");
    logger.info("Scanning for devices and waiting for connections...");
  }
}

// Create and start controller if this file is run directly
if (require.main === module) {
  const controller = new ControllerApp();

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    logger.info("Received SIGINT signal, shutting down...");
    await controller.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM signal, shutting down...");
    await controller.stop();
    process.exit(0);
  });

  // Start controller
  controller.start().catch((error) => {
    logger.error("Failed to start controller application", error);
    process.exit(1);
  });
}

export default ControllerApp;
