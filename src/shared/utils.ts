import * as crypto from "crypto";
import { DeviceType, type BaseMessage, type ProtocolMessage } from "./types";
import {
  PROTOCOL_VERSION,
  ERROR_CODES,
  DEFAULT_AUTH_TOKEN_LENGTH,
} from "./constants";

/**
 * Generate a random token of specified length
 */
export function generateToken(
  length: number = DEFAULT_AUTH_TOKEN_LENGTH,
): string {
  return crypto.randomBytes(length).toString("hex");
}

/**
 * Create a basic message structure
 */
export function createBaseMessage(
  type: string,
  senderId: string,
  senderType: DeviceType,
): BaseMessage {
  return {
    type,
    version: PROTOCOL_VERSION,
    timestamp: Date.now(),
    sender: {
      id: senderId,
      type: senderType,
    },
  };
}

/**
 * Validate incoming message
 */
export function validateMessage(message: any): {
  valid: boolean;
  error?: string;
} {
  // Check if message is an object
  if (!message || typeof message !== "object") {
    return { valid: false, error: "Message must be an object" };
  }

  // Check required fields
  if (
    !message.type ||
    !message.version ||
    !message.timestamp ||
    !message.sender
  ) {
    return { valid: false, error: "Message missing required fields" };
  }

  // Check sender
  if (!message.sender.id || !message.sender.type) {
    return { valid: false, error: "Sender missing required fields" };
  }

  // Check valid sender type
  if (
    ![DeviceType.CONTROLLER, DeviceType.TARGET].includes(message.sender.type)
  ) {
    return { valid: false, error: "Invalid sender type" };
  }

  return { valid: true };
}

/**
 * Create an error message
 */
export function createErrorMessage(
  senderId: string,
  senderType: DeviceType,
  code: number = ERROR_CODES.INTERNAL_ERROR,
  message: string = "Internal error",
): ProtocolMessage {
  return {
    ...createBaseMessage("error", senderId, senderType),
    data: {
      code,
      message,
    },
  } as ProtocolMessage;
}

/**
 * Parse a JSON message safely
 */
export function parseJsonMessage(data: string): {
  valid: boolean;
  message?: any;
  error?: string;
} {
  try {
    const message = JSON.parse(data);
    return { valid: true, message };
  } catch (error) {
    return { valid: false, error: "Invalid JSON" };
  }
}

/**
 * Check if an IP address is in the local network
 */
export function isLocalIpAddress(ip: string): boolean {
  // Check for localhost
  if (ip === "127.0.0.1" || ip === "localhost" || ip === "::1") {
    return true;
  }

  // Check for private IP ranges
  // 10.0.0.0 - 10.255.255.255
  // 172.16.0.0 - 172.31.255.255
  // 192.168.0.0 - 192.168.255.255
  const privateIpRegex = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/;
  return privateIpRegex.test(ip);
}

/**
 * Get local IP address
 */
export function getLocalIpAddress(): string | null {
  const interfaces = require("os").networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip over non-IPv4 and internal (loopback) addresses
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

/**
 * Create a simple logger
 */
export function createLogger(name: string) {
  return {
    debug: (message: string, ...args: any[]) => {
      console.debug(`[${name}] [DEBUG] ${message}`, ...args);
    },
    info: (message: string, ...args: any[]) => {
      console.info(`[${name}] [INFO] ${message}`, ...args);
    },
    warn: (message: string, ...args: any[]) => {
      console.warn(`[${name}] [WARN] ${message}`, ...args);
    },
    error: (message: string, ...args: any[]) => {
      console.error(`[${name}] [ERROR] ${message}`, ...args);
    },
  };
}
