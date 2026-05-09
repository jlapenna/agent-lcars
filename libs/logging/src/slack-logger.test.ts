import { getSlackLogLevel } from './env';
import { LogLevel } from './log-level';
import { SlackLogger } from './slack-logger';

jest.mock('./env', () => ({
  ...jest.requireActual('./env'),
  getSlackLogLevel: jest.fn(),
}));

describe('SlackLogger', () => {
  let consoleInfoSpy: jest.SpyInstance;
  let consoleDebugSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let originalSlackLogLevel: string | undefined;

  beforeEach(() => {
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation();
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    originalSlackLogLevel = process.env.SLACK_LOG_LEVEL;
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    consoleDebugSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    (getSlackLogLevel as jest.Mock).mockReturnValue(originalSlackLogLevel);
  });

  describe('getSlackLogLevel', () => {
    it('should return DEBUG by default', () => {
      (getSlackLogLevel as jest.Mock).mockReturnValue(undefined);
      expect(SlackLogger.getSlackLogLevel()).toBe(LogLevel.DEBUG);
    });

    it('should return log level from environment variable', () => {
      (getSlackLogLevel as jest.Mock).mockReturnValue('ERROR');
      expect(SlackLogger.getSlackLogLevel()).toBe(LogLevel.ERROR);

      (getSlackLogLevel as jest.Mock).mockReturnValue('warn');
      expect(SlackLogger.getSlackLogLevel()).toBe(LogLevel.WARN);

      (getSlackLogLevel as jest.Mock).mockReturnValue('INFO');
      expect(SlackLogger.getSlackLogLevel()).toBe(LogLevel.INFO);
    });

    it('should return DEBUG for invalid log level', () => {
      (getSlackLogLevel as jest.Mock).mockReturnValue('invalid');
      expect(SlackLogger.getSlackLogLevel()).toBe(LogLevel.DEBUG);
    });
  });

  describe('name prefixing', () => {
    it('should prefix log messages with logger name', () => {
      const logger = new SlackLogger('test:logger', LogLevel.DEBUG);

      logger.info('test message');
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        '[test:logger]',
        'test message',
      );

      logger.error('error message');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[test:logger]',
        'error message',
      );
    });
  });

  describe('log level filtering', () => {
    it('should log all levels when set to DEBUG', () => {
      const logger = new SlackLogger('test', LogLevel.DEBUG);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(consoleDebugSpy).toHaveBeenCalledWith('[test]', 'debug message');
      expect(consoleInfoSpy).toHaveBeenCalledWith('[test]', 'info message');
      expect(consoleWarnSpy).toHaveBeenCalledWith('[test]', 'warn message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test]', 'error message');
    });

    it('should only log INFO, WARN, ERROR when set to INFO', () => {
      const logger = new SlackLogger('test', LogLevel.INFO);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).toHaveBeenCalledWith('[test]', 'info message');
      expect(consoleWarnSpy).toHaveBeenCalledWith('[test]', 'warn message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test]', 'error message');
    });

    it('should only log WARN and ERROR when set to WARN', () => {
      const logger = new SlackLogger('test', LogLevel.WARN);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith('[test]', 'warn message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test]', 'error message');
    });

    it('should only log ERROR when set to ERROR', () => {
      const logger = new SlackLogger('test', LogLevel.ERROR);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test]', 'error message');
    });
  });

  describe('setLevel and getLevel', () => {
    it('should allow changing log level dynamically', () => {
      const logger = new SlackLogger('test', LogLevel.ERROR);

      logger.info('should not log');
      expect(consoleInfoSpy).not.toHaveBeenCalled();

      logger.setLevel(LogLevel.INFO);
      logger.info('should log now');
      expect(consoleInfoSpy).toHaveBeenCalledWith('[test]', 'should log now');

      expect(logger.getLevel()).toBe(LogLevel.INFO);
    });
  });

  describe('setName', () => {
    it('should allow changing logger name', () => {
      const logger = new SlackLogger('original', LogLevel.DEBUG);

      logger.info('first message');
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        '[original]',
        'first message',
      );

      logger.setName('updated');
      logger.info('second message');
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        '[updated]',
        'second message',
      );
    });
  });

  describe('multiple arguments', () => {
    it('should pass all arguments to console methods', () => {
      const logger = new SlackLogger('test', LogLevel.DEBUG);

      logger.info('message', { key: 'value' }, 123);
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        '[test]',
        'message',
        { key: 'value' },
        123,
      );

      logger.error('error:', new Error('test'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[test]',
        'error:',
        expect.any(Error),
      );
    });
  });
});
