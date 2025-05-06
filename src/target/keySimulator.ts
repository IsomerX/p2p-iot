import { createLogger } from "../shared/utils";

const logger = createLogger("KeySimulator");

/**
 * Interface for key simulator options
 */
interface KeySimulatorOptions {
  /**
   * The keypress engine to use ('robotjs' or 'node-key-sender')
   */
  engine?: "robotjs" | "node-key-sender";

  /**
   * Whether to log detailed information about key presses
   */
  verbose?: boolean;
}

/**
 * Interface for key press options
 */
interface KeyPressOptions {
  /**
   * Number of times to repeat the key press
   */
  repeat?: number;

  /**
   * How long to hold the key down (in milliseconds)
   */
  holdTime?: number;

  /**
   * Delay between key presses when repeating (in milliseconds)
   */
  delay?: number;
}

/**
 * Class for simulating keyboard input
 */
class KeySimulator {
  private readonly options: Required<KeySimulatorOptions>;
  private robotjs: any;
  private nodeKeySender: any;

  constructor(options: KeySimulatorOptions = {}) {
    this.options = {
      engine: options.engine || "robotjs",
      verbose: options.verbose !== undefined ? options.verbose : false,
    };

    // Try to load the selected engine
    this.loadEngine();
  }

  /**
   * Load the key simulation engine
   */
  private loadEngine(): void {
    try {
      if (this.options.engine === "robotjs") {
        try {
          // Try to load robotjs
          this.robotjs = require("robotjs");
          logger.info("Using robotjs for key simulation");
        } catch (error) {
          logger.warn(
            "Failed to load robotjs, falling back to node-key-sender",
            error,
          );
          this.options.engine = "node-key-sender";
        }
      }

      if (this.options.engine === "node-key-sender") {
        try {
          // Try to load node-key-sender
          this.nodeKeySender = require("node-key-sender");
          logger.info("Using node-key-sender for key simulation");
        } catch (error) {
          logger.error("Failed to load node-key-sender", error);
          throw new Error("No key simulation engine available");
        }
      }
    } catch (error) {
      logger.error("Failed to load any key simulation engine", error);
      throw error;
    }
  }

  /**
   * Press the left arrow key
   */
  public async pressLeftArrow(options: KeyPressOptions = {}): Promise<boolean> {
    return this.pressKey("left", options);
  }

  /**
   * Press the right arrow key
   */
  public async pressRightArrow(
    options: KeyPressOptions = {},
  ): Promise<boolean> {
    return this.pressKey("right", options);
  }

  /**
   * Press a key
   */
  public async pressKey(
    key: string,
    options: KeyPressOptions = {},
  ): Promise<boolean> {
    const repeat = options.repeat || 1;
    const holdTime = options.holdTime || 0;
    const delay = options.delay || 50;

    if (this.options.verbose) {
      logger.info(
        `Pressing key: ${key} (repeat: ${repeat}, holdTime: ${holdTime}ms, delay: ${delay}ms)`,
      );
    }

    try {
      if (this.options.engine === "robotjs" && this.robotjs) {
        return this.pressKeyWithRobotjs(key, repeat, holdTime, delay);
      } else if (
        this.options.engine === "node-key-sender" &&
        this.nodeKeySender
      ) {
        return this.pressKeyWithNodeKeySender(key, repeat, holdTime, delay);
      } else {
        logger.error("No key simulation engine available");
        return false;
      }
    } catch (error) {
      logger.error(`Error pressing key: ${key}`, error);
      return false;
    }
  }

  /**
   * Press a key using robotjs
   */
  private pressKeyWithRobotjs(
    key: string,
    repeat: number,
    holdTime: number,
    delay: number,
  ): boolean {
    try {
      for (let i = 0; i < repeat; i++) {
        if (i > 0 && delay > 0) {
          // Add delay between key presses
          this.sleep(delay);
        }

        if (holdTime > 0) {
          // Key down
          this.robotjs.keyToggle(key, "down");

          // Hold for specified time
          this.sleep(holdTime);

          // Key up
          this.robotjs.keyToggle(key, "up");
        } else {
          // Simple key tap
          this.robotjs.keyTap(key);
        }
      }

      return true;
    } catch (error) {
      logger.error(`Error pressing key with robotjs: ${key}`, error);
      return false;
    }
  }

  /**
   * Press a key using node-key-sender
   */
  private async pressKeyWithNodeKeySender(
    key: string,
    repeat: number,
    holdTime: number,
    delay: number,
  ): Promise<boolean> {
    try {
      // Map key names to node-key-sender format
      const keyMap: { [key: string]: string } = {
        left: "left",
        right: "right",
        up: "up",
        down: "down",
      };

      // Get the mapped key
      const mappedKey = keyMap[key.toLowerCase()] || key;

      if (holdTime > 0) {
        // node-key-sender doesn't support holding keys directly
        // We'll simulate it by sending multiple key presses
        const pressCount = Math.max(1, Math.floor(holdTime / 50));

        for (let i = 0; i < repeat; i++) {
          if (i > 0 && delay > 0) {
            // Add delay between repetitions
            await this.asyncSleep(delay);
          }

          // Send multiple key presses to simulate holding
          for (let j = 0; j < pressCount; j++) {
            await this.nodeKeySender.sendKey(mappedKey);
            await this.asyncSleep(10);
          }
        }
      } else {
        // Simple key presses with repetition
        if (repeat === 1) {
          await this.nodeKeySender.sendKey(mappedKey);
        } else {
          // Using the built-in repeating function
          const sequence = [];
          for (let i = 0; i < repeat; i++) {
            sequence.push(mappedKey);
            if (delay > 0 && i < repeat - 1) {
              // Add delay between key presses
              sequence.push({ delay: delay });
            }
          }

          await this.nodeKeySender.sendKeys(sequence);
        }
      }

      return true;
    } catch (error) {
      logger.error(`Error pressing key with node-key-sender: ${key}`, error);
      return false;
    }
  }

  /**
   * Synchronous sleep
   */
  private sleep(ms: number): void {
    const start = Date.now();
    while (Date.now() - start < ms) {
      // Busy wait
    }
  }

  /**
   * Asynchronous sleep
   */
  private asyncSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default KeySimulator;
