import {
  forceStructuredLogging,
  getLogLevel,
  isOnGoogleCloud,
} from '@repo/env';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  type MockInstance,
  vi,
} from 'vitest';

import { Logger, setLogDefaults } from './console-logger';
import { LogLevel } from './log-level';

vi.mock('@repo/env', async () => ({
  ...(await vi.importActual<object>('@repo/env')),
  getLogLevel: vi.fn(),
  isOnGoogleCloud: vi.fn(),
  forceStructuredLogging: vi.fn(),
}));

describe('Logger', () => {
  let consoleLogSpy: MockInstance;
  let consoleDebugSpy: MockInstance;
  let consoleWarnSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    setLogDefaults({ getLogLevel });
    consoleLogSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    consoleDebugSpy = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);
    consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    originalLogLevel = process.env.LOG_LEVEL;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleDebugSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    (getLogLevel as Mock).mockReturnValue(originalLogLevel);
  });

  describe('getLogLevel', () => {
    it('should return DEBUG by default', () => {
      (getLogLevel as Mock).mockReturnValue(undefined);
      expect(Logger.getLogLevel()).toBe(LogLevel.DEBUG);
    });

    it('should return log level from environment variable', () => {
      (getLogLevel as Mock).mockReturnValue('ERROR');
      expect(Logger.getLogLevel()).toBe(LogLevel.ERROR);

      (getLogLevel as Mock).mockReturnValue('warn');
      expect(Logger.getLogLevel()).toBe(LogLevel.WARN);

      (getLogLevel as Mock).mockReturnValue('INFO');
      expect(Logger.getLogLevel()).toBe(LogLevel.INFO);
    });

    it('should return DEBUG for invalid log level', () => {
      (getLogLevel as Mock).mockReturnValue('invalid');
      expect(Logger.getLogLevel()).toBe(LogLevel.DEBUG);
    });
  });

  describe('log level filtering', () => {
    it('should log all levels when set to DEBUG', () => {
      const logger = new Logger(LogLevel.DEBUG);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(consoleDebugSpy).toHaveBeenCalledWith('debug message');
      expect(consoleLogSpy).toHaveBeenCalledWith('info message');
      expect(consoleWarnSpy).toHaveBeenCalledWith('warn message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('error message');
    });

    it('should only log INFO, WARN, ERROR when set to INFO', () => {
      const logger = new Logger(LogLevel.INFO);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('info message');
      expect(consoleWarnSpy).toHaveBeenCalledWith('warn message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('error message');
    });

    it('should only log WARN and ERROR when set to WARN', () => {
      const logger = new Logger(LogLevel.WARN);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith('warn message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('error message');
    });

    it('should only log ERROR when set to ERROR', () => {
      const logger = new Logger(LogLevel.ERROR);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith('error message');
    });

    it('still logs ERROR when LOG_LEVEL is unset (regression: silent logger)', () => {
      // The shared `logger` in instance.ts is built from Logger.getLogLevel(),
      // which falls back to DEBUG when LOG_LEVEL is unset. Building it from the
      // raw env value (undefined) makes shouldLog(undefined, ERROR) false and
      // silently drops every line — including errors — for services that don't
      // set LOG_LEVEL (e.g. the primes/onecake web apps).
      (getLogLevel as Mock).mockReturnValue(undefined);
      const logger = new Logger(Logger.getLogLevel());

      logger.error('error message');

      expect(consoleErrorSpy).toHaveBeenCalledWith('error message');
    });
  });

  describe('getLevel', () => {
    it('should return the configured log level', () => {
      const logger = new Logger(LogLevel.WARN);
      expect(logger.getLevel()).toBe(LogLevel.WARN);
    });
  });

  describe('multiple arguments', () => {
    it('should pass all arguments to console methods', () => {
      const logger = new Logger(LogLevel.DEBUG);

      logger.info('message', { key: 'value' }, 123);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'message',
        { key: 'value' },
        123,
      );

      logger.error('error:', new Error('test'));
      expect(consoleErrorSpy).toHaveBeenCalledWith('error:', expect.any(Error));
    });

    it('should expand deep objects when running on Google Cloud', () => {
      // Mock isOnGoogleCloud to return true
      (isOnGoogleCloud as Mock).mockReturnValue(true);
      (forceStructuredLogging as Mock).mockReturnValue(false);
      setLogDefaults({
        formatter: (args) => JSON.stringify(args),
      });

      const logger = new Logger(LogLevel.DEBUG, {
        isOnGoogleCloud,
        forceStructuredLogging,
      });
      const deepObject = { a: { b: { c: { d: 'deep' } } } };

      logger.info('deep object:', deepObject);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('deep'),
      );
      // The JSON string passed to console.log should contain the fully expanded object
      const logCall = consoleLogSpy.mock.calls[0][0];
      const parsedLog = JSON.parse(logCall);
      expect(parsedLog.message).toContain('deep');
    });
  });
});
