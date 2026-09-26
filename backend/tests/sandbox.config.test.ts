import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSandboxConfig, isSandboxModeEnabled } from '../src/config/sandbox.js';

describe('Sandbox Configuration Parsing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SANDBOX_MODE_ENABLED;
    delete process.env.SANDBOX_DATABASE_URL;
    delete process.env.SANDBOX_ALLOW_HEADER;
    delete process.env.SANDBOX_ALLOW_QUERY_PARAM;
    delete process.env.SANDBOX_HEADER_NAME;
    delete process.env.SANDBOX_QUERY_PARAM_NAME;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Valid values', () => {
    it('should parse valid enabled and disabled values for SANDBOX_MODE_ENABLED', () => {
      process.env.SANDBOX_MODE_ENABLED = 'true';
      expect(getSandboxConfig().enabled).toBe(true);

      process.env.SANDBOX_MODE_ENABLED = 'false';
      expect(getSandboxConfig().enabled).toBe(false);
    });

    it('should default to disabled when SANDBOX_MODE_ENABLED is unset', () => {
      delete process.env.SANDBOX_MODE_ENABLED;
      expect(getSandboxConfig().enabled).toBe(false);
    });

    it('should parse valid values for SANDBOX_ALLOW_HEADER', () => {
      process.env.SANDBOX_ALLOW_HEADER = 'true';
      expect(getSandboxConfig().allowHeader).toBe(true);

      process.env.SANDBOX_ALLOW_HEADER = 'false';
      expect(getSandboxConfig().allowHeader).toBe(false);
    });

    it('should default to allowHeader: true when SANDBOX_ALLOW_HEADER is unset', () => {
      delete process.env.SANDBOX_ALLOW_HEADER;
      expect(getSandboxConfig().allowHeader).toBe(true);
    });

    it('should parse valid values for SANDBOX_ALLOW_QUERY_PARAM', () => {
      process.env.SANDBOX_ALLOW_QUERY_PARAM = 'true';
      expect(getSandboxConfig().allowQueryParam).toBe(true);

      process.env.SANDBOX_ALLOW_QUERY_PARAM = 'false';
      expect(getSandboxConfig().allowQueryParam).toBe(false);
    });

    it('should default to allowQueryParam: true when SANDBOX_ALLOW_QUERY_PARAM is unset', () => {
      delete process.env.SANDBOX_ALLOW_QUERY_PARAM;
      expect(getSandboxConfig().allowQueryParam).toBe(true);
    });

    it('should correctly evaluate isSandboxModeEnabled()', () => {
      process.env.SANDBOX_MODE_ENABLED = 'true';
      expect(isSandboxModeEnabled()).toBe(true);

      process.env.SANDBOX_MODE_ENABLED = 'false';
      expect(isSandboxModeEnabled()).toBe(false);
    });
  });

  describe('Invalid values', () => {
    const invalidValues = [
      'TRUE',
      'False',
      'True',
      'yes',
      'no',
      '1',
      '0',
      'enabled',
      'disabled',
      '',
      'random text',
    ];

    invalidValues.forEach((invalidValue) => {
      it(`should throw configuration error for SANDBOX_MODE_ENABLED='${invalidValue}'`, () => {
        process.env.SANDBOX_MODE_ENABLED = invalidValue;
        expect(() => getSandboxConfig()).toThrowError(
          `SANDBOX_MODE_ENABLED has invalid value '${invalidValue}'. Expected one of: 'true', 'false'.`
        );
      });

      it(`should throw configuration error for SANDBOX_ALLOW_HEADER='${invalidValue}'`, () => {
        process.env.SANDBOX_ALLOW_HEADER = invalidValue;
        expect(() => getSandboxConfig()).toThrowError(
          `SANDBOX_ALLOW_HEADER has invalid value '${invalidValue}'. Expected one of: 'true', 'false'.`
        );
      });

      it(`should throw configuration error for SANDBOX_ALLOW_QUERY_PARAM='${invalidValue}'`, () => {
        process.env.SANDBOX_ALLOW_QUERY_PARAM = invalidValue;
        expect(() => getSandboxConfig()).toThrowError(
          `SANDBOX_ALLOW_QUERY_PARAM has invalid value '${invalidValue}'. Expected one of: 'true', 'false'.`
        );
      });
    });
  });
});
