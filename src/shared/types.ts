export interface DeviceInfo {
  id: string;
  name: string;
  ip: string;
  mac?: string;
  type: DeviceType;
  supportedCommands: string[];
}

// Device types
export enum DeviceType {
  CONTROLLER = "controller",
  TARGET = "target",
}

// Connection status
export enum ConnectionStatus {
  DISCONNECTED = "disconnected",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  PAIRED = "paired",
  ERROR = "error",
}

// Base message interface
export interface BaseMessage {
  type: string;
  version: string;
  timestamp: number;
  sender: {
    id: string;
    type: DeviceType;
  };
}

// Announce message - broadcast by controller to discover devices
export interface AnnounceMessage extends BaseMessage {
  type: "announce";
  data: {
    controllerInfo: DeviceInfo;
    discoveryPort: number;
    controlPort: number;
  };
}

// Register message - sent by target to register with controller
export interface RegisterMessage extends BaseMessage {
  type: "register";
  data: {
    deviceInfo: DeviceInfo;
  };
}

// Registered message - confirmation from controller
export interface RegisteredMessage extends BaseMessage {
  type: "registered";
  data: {
    deviceId: string;
    pairingRequired: boolean;
    pairingToken?: string;
  };
}

// Command message - sent from controller to target
export interface CommandMessage extends BaseMessage {
  type: "command";
  data: {
    commandType: string;
    parameters?: Record<string, any>;
  };
}

// Command result message - response from target to controller
export interface CommandResultMessage extends BaseMessage {
  type: "command_result";
  data: {
    commandType: string;
    success: boolean;
    error?: string;
    result?: any;
  };
}

// Pairing request message
export interface PairingRequestMessage extends BaseMessage {
  type: "pairing_request";
  data: {
    pairingToken: string;
  };
}

// Pairing response message
export interface PairingResponseMessage extends BaseMessage {
  type: "pairing_response";
  data: {
    accepted: boolean;
    authToken?: string;
    error?: string;
  };
}

// Error message
export interface ErrorMessage extends BaseMessage {
  type: "error";
  data: {
    code: number;
    message: string;
  };
}

// Union type for all messages
export type ProtocolMessage =
  | AnnounceMessage
  | RegisterMessage
  | RegisteredMessage
  | CommandMessage
  | CommandResultMessage
  | PairingRequestMessage
  | PairingResponseMessage
  | ErrorMessage;

// Connection options
export interface ConnectionOptions {
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  authToken?: string;
}

// Arrow command parameters
export interface ArrowCommandParameters {
  direction: "left" | "right";
  repeat?: number; // Number of times to repeat the key press
  holdTime?: number; // How long to hold the key in milliseconds
}
