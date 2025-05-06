export const DEFAULT_CONTROLLER_PORT = 3000;
export const DEFAULT_WEBSOCKET_PORT = 8080;
export const DEFAULT_DISCOVERY_PORT = 8081;
export const DEFAULT_BROADCAST_INTERVAL = 5000; // 5 seconds
export const DEVICE_SCAN_INTERVAL = 30000; // 30 seconds

// Protocol constants
export const PROTOCOL_VERSION = "1.0.0";
export const PROTOCOL_NAME = "arrow-control";

// Message types
export const MESSAGE_TYPES = {
  ANNOUNCE: "announce",
  REGISTER: "register",
  REGISTERED: "registered",
  COMMAND: "command",
  COMMAND_RESULT: "command_result",
  HEARTBEAT: "heartbeat",
  HEARTBEAT_ACK: "heartbeat_ack",
  PAIRING_REQUEST: "pairing_request",
  PAIRING_RESPONSE: "pairing_response",
  ERROR: "error",
} as const;

// Command types
export const COMMAND_TYPES = {
  ARROW_LEFT: "arrow_left",
  ARROW_RIGHT: "arrow_right",
} as const;

// Error codes
export const ERROR_CODES = {
  INVALID_MESSAGE: 100,
  AUTHENTICATION_FAILED: 101,
  INVALID_COMMAND: 102,
  INTERNAL_ERROR: 103,
  NOT_PAIRED: 104,
} as const;

// Security
export const DEFAULT_AUTH_TOKEN_LENGTH = 32;
export const PAIRING_TIMEOUT = 60000; // 1 minute

// Websocket constants
export const WS_PING_INTERVAL = 30000; // 30 seconds
export const WS_PING_TIMEOUT = 5000; // 5 seconds
