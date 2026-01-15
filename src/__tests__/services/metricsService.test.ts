import { describe, it, expect } from 'vitest';
import { formatDuration, formatBytes, formatUsd } from '@/services/metricsService';

describe('metricsService formatters', () => {
  describe('formatDuration', () => {
    it('should format milliseconds correctly', () => {
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('should format seconds correctly', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(5500)).toBe('5.5s');
      expect(formatDuration(59999)).toBe('60.0s'); // Edge of minute boundary
    });

    it('should format minutes correctly', () => {
      expect(formatDuration(60000)).toBe('1.0m');
      expect(formatDuration(90000)).toBe('1.5m');
      expect(formatDuration(3599999)).toBe('60.0m'); // Edge of hour boundary
    });

    it('should format hours correctly', () => {
      expect(formatDuration(3600000)).toBe('1.0h');
      expect(formatDuration(5400000)).toBe('1.5h');
      expect(formatDuration(7200000)).toBe('2.0h');
    });

    // Tests for defensive handling of invalid values
    it('should handle undefined gracefully', () => {
      expect(formatDuration(undefined)).toBe('-');
    });

    it('should handle null gracefully', () => {
      expect(formatDuration(null)).toBe('-');
    });

    it('should handle NaN gracefully', () => {
      expect(formatDuration(NaN)).toBe('-');
      expect(formatDuration(undefined as any / 1000)).toBe('-');
    });

    it('should handle negative values gracefully', () => {
      expect(formatDuration(-1)).toBe('-');
      expect(formatDuration(-1000)).toBe('-');
    });

    it('should handle zero as missing data', () => {
      // 0ms is meaningless for processing/duration - treat as missing
      expect(formatDuration(0)).toBe('-');
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(1023)).toBe('1023 B');
    });

    it('should format kilobytes correctly', () => {
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(1048575)).toBe('1024.0 KB');
    });

    it('should format megabytes correctly', () => {
      expect(formatBytes(1048576)).toBe('1.0 MB');
      expect(formatBytes(1572864)).toBe('1.5 MB');
    });

    it('should format gigabytes correctly', () => {
      expect(formatBytes(1073741824)).toBe('1.00 GB');
      expect(formatBytes(2147483648)).toBe('2.00 GB');
    });

    // Tests for defensive handling
    it('should handle undefined gracefully', () => {
      expect(formatBytes(undefined)).toBe('-');
    });

    it('should handle null gracefully', () => {
      expect(formatBytes(null)).toBe('-');
    });

    it('should handle NaN gracefully', () => {
      expect(formatBytes(NaN)).toBe('-');
    });

    it('should handle negative values gracefully', () => {
      expect(formatBytes(-1)).toBe('-');
      expect(formatBytes(-1024)).toBe('-');
    });
  });

  describe('formatUsd', () => {
    it('should format micro-amounts correctly', () => {
      expect(formatUsd(0.000001)).toBe('$0.000001');
      expect(formatUsd(0.009999)).toBe('$0.009999');
    });

    it('should format sub-dollar amounts correctly', () => {
      expect(formatUsd(0.01)).toBe('$0.0100');
      expect(formatUsd(0.5)).toBe('$0.5000');
      expect(formatUsd(0.9999)).toBe('$0.9999');
    });

    it('should format dollar amounts correctly', () => {
      expect(formatUsd(1)).toBe('$1.00');
      expect(formatUsd(10)).toBe('$10.00');
      expect(formatUsd(999.99)).toBe('$999.99');
    });

    // Tests for defensive handling
    it('should handle undefined gracefully', () => {
      expect(formatUsd(undefined)).toBe('$0.00');
    });

    it('should handle null gracefully', () => {
      expect(formatUsd(null)).toBe('$0.00');
    });

    it('should handle NaN gracefully', () => {
      expect(formatUsd(NaN)).toBe('$0.00');
    });

    it('should handle zero correctly', () => {
      expect(formatUsd(0)).toBe('$0.000000');
    });
  });
});
