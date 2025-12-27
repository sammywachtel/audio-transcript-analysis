/**
 * Metrics Hooks
 *
 * React hooks for fetching observability data from Firestore.
 * Wraps the metricsService with proper React state management.
 *
 * These hooks follow the same patterns as AuthContext:
 * - useState for loading/error/data
 * - useEffect for async fetching
 * - Proper cleanup to avoid memory leaks
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  getGlobalStats,
  getDailyStats,
  getUserStats,
  getAllUserStatsSummaries,
  getRecentMetrics,
  getPricingConfigs,
  getCurrentPricing,
  getDateRange,
  GlobalStats,
  DailyStats,
  UserStats,
  ProcessingMetric,
  PricingConfig
} from '../services/metricsService';
import { Timestamp } from 'firebase/firestore';

// =============================================================================
// Common Types
// =============================================================================

interface UseQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

interface UseQueryArrayResult<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

// =============================================================================
// Global Stats Hook (Admin)
// =============================================================================

/**
 * Fetch global stats for admin dashboard
 * Only succeeds if user has admin permissions
 */
export function useGlobalStats(): UseQueryResult<GlobalStats> {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<GlobalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  const refetch = useCallback(() => {
    setRefetchTrigger(prev => prev + 1);
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setData(null);
      setLoading(false);
      setError(new Error('Admin access required'));
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getGlobalStats()
      .then(result => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[useGlobalStats] Failed to fetch:', err);
          setError(err);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin, refetchTrigger]);

  return { data, loading, error, refetch };
}

// =============================================================================
// Daily Stats Hook (Admin)
// =============================================================================

interface UseDailyStatsOptions {
  startDate?: string;  // YYYY-MM-DD
  endDate?: string;    // YYYY-MM-DD
  days?: number;       // Alternative: last N days (default: 30)
}

/**
 * Fetch daily stats for time-series charts
 * Supports either explicit date range or "last N days"
 */
export function useDailyStats(options: UseDailyStatsOptions = {}): UseQueryArrayResult<DailyStats> {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<DailyStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  const refetch = useCallback(() => {
    setRefetchTrigger(prev => prev + 1);
  }, []);

  // Determine date range
  const { days = 30 } = options;
  let { startDate, endDate } = options;

  if (!startDate || !endDate) {
    const range = getDateRange(days);
    startDate = startDate || range.startDate;
    endDate = endDate || range.endDate;
  }

  useEffect(() => {
    if (!isAdmin) {
      setData([]);
      setLoading(false);
      setError(new Error('Admin access required'));
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getDailyStats(startDate!, endDate!)
      .then(result => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[useDailyStats] Failed to fetch:', err);
          setError(err);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin, startDate, endDate, refetchTrigger]);

  return { data, loading, error, refetch };
}

// =============================================================================
// User Stats Hook
// =============================================================================

/**
 * Fetch stats for a specific user
 * Users can fetch their own stats; admins can fetch anyone's
 */
export function useUserStats(userId?: string): UseQueryResult<UserStats> {
  const { user, isAdmin } = useAuth();
  const [data, setData] = useState<UserStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  const refetch = useCallback(() => {
    setRefetchTrigger(prev => prev + 1);
  }, []);

  // Default to current user if no userId provided
  const targetUserId = userId || user?.uid;

  useEffect(() => {
    if (!targetUserId) {
      setData(null);
      setLoading(false);
      setError(new Error('No user ID available'));
      return;
    }

    // Security check: only allow fetching own stats or if admin
    if (targetUserId !== user?.uid && !isAdmin) {
      setData(null);
      setLoading(false);
      setError(new Error('Not authorized to view this user\'s stats'));
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getUserStats(targetUserId)
      .then(result => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[useUserStats] Failed to fetch:', err);
          setError(err);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [targetUserId, user?.uid, isAdmin, refetchTrigger]);

  return { data, loading, error, refetch };
}

// =============================================================================
// All User Stats Summaries Hook (Admin)
// =============================================================================

interface UserStatsSummary {
  userId: string;
  conversationsExisting: number;
  audioHoursProcessed: number;
  estimatedCostUsd: number;
  lastActivityAt: Timestamp;
}

/**
 * Fetch summary stats for all users (admin user list)
 */
export function useAllUserStatsSummaries(maxResults: number = 100): UseQueryArrayResult<UserStatsSummary> {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<UserStatsSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  const refetch = useCallback(() => {
    setRefetchTrigger(prev => prev + 1);
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setData([]);
      setLoading(false);
      setError(new Error('Admin access required'));
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getAllUserStatsSummaries(maxResults)
      .then(result => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[useAllUserStatsSummaries] Failed to fetch:', err);
          setError(err);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin, maxResults, refetchTrigger]);

  return { data, loading, error, refetch };
}

// =============================================================================
// Recent Metrics Hook
// =============================================================================

interface UseRecentMetricsOptions {
  userId?: string;
  maxResults?: number;
  status?: 'success' | 'failed';
}

/**
 * Fetch recent processing metrics (job history)
 * Can filter by user (for personal stats) or status (for debugging)
 */
export function useRecentMetrics(options: UseRecentMetricsOptions = {}): UseQueryArrayResult<ProcessingMetric> {
  const { user, isAdmin } = useAuth();
  const [data, setData] = useState<ProcessingMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  const refetch = useCallback(() => {
    setRefetchTrigger(prev => prev + 1);
  }, []);

  const { userId, maxResults = 50, status } = options;

  // For non-admins, force userId to their own
  const effectiveUserId = isAdmin ? userId : user?.uid;

  useEffect(() => {
    // Must be authenticated
    if (!user) {
      setData([]);
      setLoading(false);
      setError(new Error('Authentication required'));
      return;
    }

    // Non-admins can only view their own metrics
    if (!isAdmin && !effectiveUserId) {
      setData([]);
      setLoading(false);
      setError(new Error('No user ID available'));
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getRecentMetrics({ userId: effectiveUserId, maxResults, status })
      .then(result => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[useRecentMetrics] Failed to fetch:', err);
          setError(err);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user, isAdmin, effectiveUserId, maxResults, status, refetchTrigger]);

  return { data, loading, error, refetch };
}

// =============================================================================
// Pricing Config Hooks
// =============================================================================

/**
 * Fetch all pricing configurations
 */
export function usePricingConfigs(): UseQueryArrayResult<PricingConfig> {
  const { user } = useAuth();
  const [data, setData] = useState<PricingConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  const refetch = useCallback(() => {
    setRefetchTrigger(prev => prev + 1);
  }, []);

  useEffect(() => {
    if (!user) {
      setData([]);
      setLoading(false);
      setError(new Error('Authentication required'));
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getPricingConfigs()
      .then(result => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[usePricingConfigs] Failed to fetch:', err);
          setError(err);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user, refetchTrigger]);

  return { data, loading, error, refetch };
}

/**
 * Fetch current pricing for a specific model
 */
export function useCurrentPricing(model: string): UseQueryResult<PricingConfig> {
  const { user } = useAuth();
  const [data, setData] = useState<PricingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  const refetch = useCallback(() => {
    setRefetchTrigger(prev => prev + 1);
  }, []);

  useEffect(() => {
    if (!user) {
      setData(null);
      setLoading(false);
      setError(new Error('Authentication required'));
      return;
    }

    if (!model) {
      setData(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getCurrentPricing(model)
      .then(result => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[useCurrentPricing] Failed to fetch:', err);
          setError(err);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user, model, refetchTrigger]);

  return { data, loading, error, refetch };
}

// =============================================================================
// Convenience Hook for Current User Stats
// =============================================================================

/**
 * Shorthand for fetching the current user's own stats
 * Just a wrapper around useUserStats() with no userId
 */
export function useMyStats(): UseQueryResult<UserStats> {
  return useUserStats();
}
