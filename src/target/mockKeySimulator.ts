import { createLogger } from '../shared/utils';

const logger = createLogger('MockKeySimulator');

/**
 * Interface for key simulator options
 */
interface KeySimulatorOptions {
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
 * Mock implementation of KeySimulator that doesn't require external packages
 * Just logs the key presses instead of actually simulating them
 */
class MockKeySimulator {
  private readonly verbose: boolean;
  
  constructor(options: KeySimulatorOptions = {}) {
    this.verbose = options.verbose || false;
    logger.info('Using mock key simulator - key presses will be logged but not actually simulated');
  }
  
  /**
   * Press the left arrow key
   */
  public async pressLeftArrow(options: KeyPressOptions = {}): Promise<boolean> {
    return this.pressKey('left', options);
  }
  
  /**
   * Press the right arrow key
   */
  public async pressRightArrow(options: KeyPressOptions = {}): Promise<boolean> {
    return this.pressKey('right', options);
  }
  
  /**
   * Press a key
   */
  public async pressKey(key: string, options: KeyPressOptions = {}): Promise<boolean> {
    const repeat = options.repeat || 1;
    const holdTime = options.holdTime || 0;
    const delay = options.delay || 50;
    
    logger.info(`MOCK: Simulating key press: ${key} (repeat: ${repeat}, holdTime: ${holdTime}ms, delay: ${delay}ms)`);
    
    if (this.verbose) {
      for (let i = 0; i < repeat; i++) {
        logger.info(`MOCK: Press ${i + 1}/${repeat}: ${key}`);
        if (holdTime > 0) {
          logger.info(`MOCK: Holding ${key} for ${holdTime}ms`);
        }
        if (i < repeat - 1 && delay > 0) {
          logger.info(`MOCK: Waiting ${delay}ms before next press`);
        }
        
        // Simulate the delay to make the experience more realistic
        await this.sleep(Math.min(delay, 50)); // Cap at 50ms for testing purposes
      }
    }
    
    return true;
  }
  
  /**
   * Asynchronous sleep function
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default MockKeySimulator;
