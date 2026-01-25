/**
 * AdminDashboard - Enhanced observability dashboard for admin users
 *
 * Features:
 * - Overview tab: Global aggregates + time-series charts
 * - Users tab: User list with drill-down to individual stats
 * - Jobs tab: Recent processing jobs with filtering
 * - Pricing tab: Cost configuration management (Phase 8)
 *
 * Data sources:
 * - _global_stats/current: System-wide aggregates
 * - _daily_stats/{date}: Time-series for charts
 * - _user_stats/{userId}: Per-user aggregates
 * - _metrics: Individual job records
 */

import React, { useState } from 'react';
import { Button } from '../components/Button';
import { ArrowLeft, Activity, Users, Loader2, DollarSign, TrendingUp, Clock, FileAudio, RefreshCw, Zap, MessageSquare, Shield, AlertTriangle, CheckCircle } from 'lucide-react';
import { getFunctions, httpsCallable } from 'firebase/functions';

// Hooks
import {
  useGlobalStats,
  useDailyStats,
  useAllUserStatsSummaries,
  useRecentMetrics,
  useUserStats,
  useChatMetrics,
  useReconciliationQuality
} from '../hooks/useMetrics';

// Components
import {
  StatCard,
  StatCardSkeleton,
  TimeSeriesChart,
  TimeSeriesChartSkeleton,
  MetricsTable,
  MetricsTableSkeleton
} from '../components/metrics';
import { formatDuration, formatUsd, calculateCostSummary, ProcessingMetric } from '../services/metricsService';
import { PricingManager } from '../components/admin/PricingManager';
import { ChatMetricsTable } from '../components/admin/ChatMetricsTable';

interface AdminDashboardProps {
  onBack: () => void;
  onJobClick?: (metricId: string) => void;
}

type TabId = 'overview' | 'users' | 'jobs' | 'chat' | 'quality' | 'pricing';

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ onBack, onJobClick }) => {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState(30); // Last N days

  // Data hooks
  const globalStats = useGlobalStats();
  const dailyStats = useDailyStats({ days: dateRange });
  const userSummaries = useAllUserStatsSummaries(100);
  const recentMetrics = useRecentMetrics({ maxResults: 50 });
  const chatMetrics = useChatMetrics({ maxResults: 100 });

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <Activity size={16} /> },
    { id: 'users', label: 'Users', icon: <Users size={16} /> },
    { id: 'jobs', label: 'Jobs', icon: <Clock size={16} /> },
    { id: 'chat', label: 'Chat', icon: <MessageSquare size={16} /> },
    { id: 'quality', label: 'Quality', icon: <Shield size={16} /> },
    { id: 'pricing', label: 'Pricing', icon: <DollarSign size={16} /> },
  ];

  return (
    <div className="min-h-screen bg-slate-50 p-6 md:p-12">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
            <p className="text-slate-500 mt-1">Processing metrics and observability</p>
          </div>
          <Button variant="ghost" onClick={onBack} className="gap-2">
            <ArrowLeft size={18} />
            Back to Library
          </Button>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 border-b border-slate-200">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                setSelectedUserId(null);
              }}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors
                ${activeTab === tab.id
                  ? 'text-blue-600 border-b-2 border-blue-600 -mb-px'
                  : 'text-slate-600 hover:text-slate-900'
                }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <OverviewTab
            globalStats={globalStats}
            dailyStats={dailyStats}
            recentMetrics={recentMetrics}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
          />
        )}

        {activeTab === 'users' && (
          <UsersTab
            userSummaries={userSummaries}
            selectedUserId={selectedUserId}
            onSelectUser={setSelectedUserId}
          />
        )}

        {activeTab === 'jobs' && (
          <JobsTab recentMetrics={recentMetrics} onJobClick={onJobClick} />
        )}

        {activeTab === 'chat' && (
          <ChatTab chatMetrics={chatMetrics} />
        )}

        {activeTab === 'quality' && (
          <QualityTab />
        )}

        {activeTab === 'pricing' && (
          <PricingManager />
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Overview Tab
// =============================================================================

interface OverviewTabProps {
  globalStats: ReturnType<typeof useGlobalStats>;
  dailyStats: ReturnType<typeof useDailyStats>;
  recentMetrics: ReturnType<typeof useRecentMetrics>;
  dateRange: number;
  onDateRangeChange: (days: number) => void;
}

const OverviewTab: React.FC<OverviewTabProps> = ({
  globalStats,
  dailyStats,
  recentMetrics,
  dateRange,
  onDateRangeChange
}) => {
  const { data: stats, loading: statsLoading, error: statsError, refetch: refetchStats } = globalStats;
  const { data: daily, loading: dailyLoading, refetch: refetchDaily } = dailyStats;
  const { data: metricsData } = recentMetrics;

  // Calculate actual cost summary from recent metrics
  const processingMetrics = (metricsData || []).filter((m): m is ProcessingMetric => !('type' in m) || m.type !== 'chat');
  const costSummary = calculateCostSummary(processingMetrics);

  const [computingStats, setComputingStats] = useState(false);
  const [computeResult, setComputeResult] = useState<string | null>(null);
  const [syncingBilling, setSyncingBilling] = useState(false);
  const [billingResult, setBillingResult] = useState<string | null>(null);
  const [diagnosingLabels, setDiagnosingLabels] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState<string | null>(null);

  const handleRefresh = () => {
    refetchStats();
    refetchDaily();
  };

  const handleComputeStats = async () => {
    setComputingStats(true);
    setComputeResult(null);
    try {
      const functions = getFunctions();
      const triggerStats = httpsCallable(functions, 'triggerStatsComputation');
      const result = await triggerStats() as { data: { success: boolean; globalStats: { totalUsers: number; totalConversations: number } } };

      if (result.data.success) {
        setComputeResult(`Stats computed! ${result.data.globalStats.totalUsers} users, ${result.data.globalStats.totalConversations} conversations`);
        // Refresh the data after computing
        setTimeout(() => {
          refetchStats();
          refetchDaily();
        }, 1000);
      }
    } catch (error) {
      setComputeResult(`Error: ${error instanceof Error ? error.message : 'Failed to compute stats'}`);
    } finally {
      setComputingStats(false);
    }
  };

  const handleSyncBilling = async () => {
    setSyncingBilling(true);
    setBillingResult(null);
    try {
      const functions = getFunctions();
      const triggerSync = httpsCallable(functions, 'triggerBillingSync');
      const result = await triggerSync() as {
        data: {
          success: boolean;
          conversationsQueried: number;
          metricsUpdated: number;
          metricsAlreadySynced: number;
          totalActualCostUsd: number;
          errors: string[];
        }
      };

      if (result.data.success) {
        const { conversationsQueried, metricsUpdated, metricsAlreadySynced, totalActualCostUsd } = result.data;
        if (conversationsQueried === 0) {
          setBillingResult('No billing data found in BigQuery for the last 7 days. Labels may not be appearing in billing exports yet.');
        } else {
          setBillingResult(
            `Synced! Found ${conversationsQueried} conversations in BigQuery. ` +
            `Updated ${metricsUpdated} metrics, ${metricsAlreadySynced} already synced. ` +
            `Total actual cost: $${totalActualCostUsd.toFixed(4)}`
          );
        }
      }
    } catch (error) {
      setBillingResult(`Error: ${error instanceof Error ? error.message : 'Failed to sync billing'}`);
    } finally {
      setSyncingBilling(false);
    }
  };

  const handleDiagnoseLabels = async () => {
    setDiagnosingLabels(true);
    setDiagnoseResult(null);
    try {
      const functions = getFunctions();
      const diagnose = httpsCallable(functions, 'diagnoseBillingLabels');
      const result = await diagnose() as {
        data: {
          success: boolean;
          diagnosis: {
            vertexAiUsage: { row_count: number; total_cost_usd: number; earliest_usage?: string; latest_usage?: string };
            labelsOverview: { rows_with_labels: number; unique_label_keys: number };
            labelKeys: Array<{ key: string; occurrences: number; sampleValues: string[] }>;
          };
          hint: string;
        }
      };

      if (result.data.success) {
        const { diagnosis, hint } = result.data;
        const usage = diagnosis.vertexAiUsage;
        const labels = diagnosis.labelsOverview;

        let msg = `Vertex AI: ${usage.row_count} rows, $${Number(usage.total_cost_usd).toFixed(4)} total cost.\n`;
        msg += `Labels: ${labels.rows_with_labels} rows with labels, ${labels.unique_label_keys} unique keys.\n`;

        if (diagnosis.labelKeys.length > 0) {
          msg += `Keys found: ${diagnosis.labelKeys.map(k => `${k.key} (${k.occurrences})`).join(', ')}\n`;
        }
        msg += hint;
        setDiagnoseResult(msg);
      }
    } catch (error) {
      setDiagnoseResult(`Error: ${error instanceof Error ? error.message : 'Failed to diagnose labels'}`);
    } finally {
      setDiagnosingLabels(false);
    }
  };

  // Show compute button if no stats exist yet
  if (!stats && !statsLoading && !statsError) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-8 text-center">
        <h3 className="text-lg font-medium text-amber-800 mb-2">No Stats Data Yet</h3>
        <p className="text-amber-600 mb-4">
          Stats are computed daily at 2 AM UTC. Click below to compute now.
        </p>
        <Button
          onClick={handleComputeStats}
          disabled={computingStats}
          className="gap-2"
        >
          {computingStats ? <Loader2 className="animate-spin" size={16} /> : <Zap size={16} />}
          {computingStats ? 'Computing...' : 'Compute Stats Now'}
        </Button>
        {computeResult && (
          <p className={`mt-4 text-sm ${computeResult.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>
            {computeResult}
          </p>
        )}
      </div>
    );
  }

  if (statsError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
        Failed to load stats: {statsError.message}
      </div>
    );
  }

  // Transform daily stats for chart
  const chartData = daily.map(d => ({
    date: d.date,
    activeUsers: d.activeUsers,
    jobsSucceeded: d.jobsSucceeded,
    jobsFailed: d.jobsFailed,
    audioHours: Math.round(d.audioHoursProcessed * 100) / 100,
    cost: d.estimatedCostUsd
  }));

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">Time range:</span>
          <select
            value={dateRange}
            onChange={(e) => onDateRangeChange(Number(e.target.value))}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleRefresh} className="gap-2">
            <RefreshCw size={14} />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleComputeStats}
            disabled={computingStats}
            className="gap-2"
          >
            {computingStats ? <Loader2 className="animate-spin" size={14} /> : <Zap size={14} />}
            {computingStats ? 'Computing...' : 'Recompute Stats'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSyncBilling}
            disabled={syncingBilling}
            className="gap-2"
          >
            {syncingBilling ? <Loader2 className="animate-spin" size={14} /> : <DollarSign size={14} />}
            {syncingBilling ? 'Syncing...' : 'Sync Billing'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDiagnoseLabels}
            disabled={diagnosingLabels}
            className="gap-2"
          >
            {diagnosingLabels ? <Loader2 className="animate-spin" size={14} /> : <Activity size={14} />}
            {diagnosingLabels ? 'Diagnosing...' : 'Diagnose Labels'}
          </Button>
        </div>
      </div>

      {/* Compute stats result message */}
      {computeResult && (
        <div className={`p-3 rounded-lg text-sm ${
          computeResult.startsWith('Error')
            ? 'bg-red-50 text-red-700 border border-red-200'
            : 'bg-green-50 text-green-700 border border-green-200'
        }`}>
          {computeResult}
        </div>
      )}

      {/* Billing sync result message */}
      {billingResult && (
        <div className={`p-3 rounded-lg text-sm ${
          billingResult.startsWith('Error')
            ? 'bg-red-50 text-red-700 border border-red-200'
            : billingResult.includes('No billing data')
            ? 'bg-amber-50 text-amber-700 border border-amber-200'
            : 'bg-green-50 text-green-700 border border-green-200'
        }`}>
          {billingResult}
        </div>
      )}

      {/* Diagnose labels result message */}
      {diagnoseResult && (
        <div className={`p-3 rounded-lg text-sm whitespace-pre-wrap ${
          diagnoseResult.startsWith('Error')
            ? 'bg-red-50 text-red-700 border border-red-200'
            : diagnoseResult.includes('No labels found')
            ? 'bg-amber-50 text-amber-700 border border-amber-200'
            : 'bg-blue-50 text-blue-700 border border-blue-200'
        }`}>
          {diagnoseResult}
        </div>
      )}

      {/* Global Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statsLoading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : stats ? (
          <>
            <StatCard
              label="Total Users"
              value={stats.users.totalUsers.toLocaleString()}
              sublabel={`${stats.users.activeUsersLast7Days} active this week`}
              icon={<Users size={20} className="text-blue-500" />}
            />
            <StatCard
              label="Total Jobs"
              value={stats.processing.totalJobsAllTime.toLocaleString()}
              sublabel={`${stats.processing.successRate.toFixed(1)}% success rate`}
              icon={<Activity size={20} className="text-emerald-500" />}
            />
            <StatCard
              label="Audio Processed"
              value={`${stats.processing.totalAudioHoursProcessed.toFixed(1)}h`}
              sublabel={`${stats.conversations.totalConversationsExisting} conversations`}
              icon={<FileAudio size={20} className="text-purple-500" />}
            />
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign size={20} className="text-amber-500" />
                <span className="text-xs text-slate-500 font-medium">Total Cost</span>
              </div>
              <div className="space-y-2">
                <div>
                  <p className="text-2xl font-bold text-slate-900">
                    {formatUsd(stats.llmUsage.estimatedTotalCostUsd)}
                  </p>
                  <p className="text-xs text-slate-500">Estimated (all time)</p>
                </div>
                {costSummary.jobsWithActual > 0 && (
                  <div className="pt-2 border-t border-slate-100">
                    <div className="flex items-baseline gap-2">
                      <p className="text-lg font-semibold text-emerald-600">
                        {formatUsd(costSummary.actual)}
                      </p>
                      <span className="text-xs text-emerald-600">actual</span>
                    </div>
                    <p className="text-xs text-slate-400">
                      {costSummary.jobsWithActual} of {costSummary.totalJobs} jobs synced ({costSummary.actualCoverage.toFixed(0)}%)
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="col-span-4 text-center text-slate-500 py-8">
            No global stats available yet
          </div>
        )}
      </div>

      {/* Processing Time Stats */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            label="Avg Processing Time"
            value={formatDuration(stats.processing.avgProcessingTimeMs)}
            icon={<Clock size={20} className="text-slate-400" />}
          />
          <StatCard
            label="Gemini Tokens"
            value={`${((stats.llmUsage.totalGeminiInputTokens + stats.llmUsage.totalGeminiOutputTokens) / 1_000_000).toFixed(2)}M`}
            sublabel={`${(stats.llmUsage.totalGeminiInputTokens / 1_000_000).toFixed(2)}M in / ${(stats.llmUsage.totalGeminiOutputTokens / 1_000_000).toFixed(2)}M out`}
            icon={<TrendingUp size={20} className="text-slate-400" />}
          />
          <StatCard
            label="WhisperX Compute"
            value={formatDuration(stats.llmUsage.totalWhisperXComputeSeconds * 1000)}
            sublabel="Total compute time"
            icon={<Clock size={20} className="text-slate-400" />}
          />
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {dailyLoading ? (
          <>
            <TimeSeriesChartSkeleton height={250} />
            <TimeSeriesChartSkeleton height={250} />
          </>
        ) : (
          <>
            <TimeSeriesChart
              data={chartData}
              series={[
                { key: 'jobsSucceeded', name: 'Successful Jobs', color: '#10b981' },
                { key: 'jobsFailed', name: 'Failed Jobs', color: '#ef4444' }
              ]}
              title="Daily Processing Jobs"
              height={250}
            />
            <TimeSeriesChart
              data={chartData}
              series={[
                { key: 'activeUsers', name: 'Active Users', color: '#3b82f6' }
              ]}
              title="Daily Active Users"
              height={250}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {dailyLoading ? (
          <>
            <TimeSeriesChartSkeleton height={250} />
            <TimeSeriesChartSkeleton height={250} />
          </>
        ) : (
          <>
            <TimeSeriesChart
              data={chartData}
              series={[
                { key: 'audioHours', name: 'Audio Hours', color: '#8b5cf6', type: 'area' }
              ]}
              title="Daily Audio Processed (hours)"
              height={250}
              formatValue={(v) => `${v.toFixed(2)}h`}
            />
            <TimeSeriesChart
              data={chartData}
              series={[
                { key: 'cost', name: 'Estimated Cost', color: '#f59e0b', type: 'area' }
              ]}
              title="Daily Estimated Cost"
              height={250}
              formatValue={(v) => formatUsd(v)}
            />
          </>
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Users Tab
// =============================================================================

interface UsersTabProps {
  userSummaries: ReturnType<typeof useAllUserStatsSummaries>;
  selectedUserId: string | null;
  onSelectUser: (userId: string | null) => void;
}

const UsersTab: React.FC<UsersTabProps> = ({
  userSummaries,
  selectedUserId,
  onSelectUser
}) => {
  const { data: users, loading, error, refetch } = userSummaries;
  const selectedUserStats = useUserStats(selectedUserId || undefined);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
        Failed to load users: {error.message}
      </div>
    );
  }

  if (selectedUserId) {
    return (
      <UserDetailView
        userId={selectedUserId}
        userStats={selectedUserStats}
        onBack={() => onSelectUser(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">User Activity</h2>
        <Button variant="ghost" size="sm" onClick={refetch} className="gap-2">
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 animate-pulse">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-6 py-4 flex gap-4">
              <div className="h-4 bg-slate-200 rounded w-32" />
              <div className="h-4 bg-slate-200 rounded flex-1" />
              <div className="h-4 bg-slate-200 rounded w-20" />
            </div>
          ))}
        </div>
      ) : users.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-500">
          No user activity recorded yet
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  User ID
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Conversations
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Audio Hours
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Est. Cost
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Last Active
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((user) => (
                <tr
                  key={user.userId}
                  onClick={() => onSelectUser(user.userId)}
                  className="hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <td className="px-6 py-4 font-mono text-slate-900">
                    {user.userId.slice(0, 12)}...
                  </td>
                  <td className="px-6 py-4 text-right text-slate-600">
                    {user.conversationsExisting}
                  </td>
                  <td className="px-6 py-4 text-right text-slate-600">
                    {user.audioHoursProcessed.toFixed(2)}h
                  </td>
                  <td className="px-6 py-4 text-right font-medium text-slate-900">
                    {formatUsd(user.estimatedCostUsd)}
                  </td>
                  <td className="px-6 py-4 text-slate-600">
                    {user.lastActivityAt?.toDate?.()
                      ? user.lastActivityAt.toDate().toLocaleDateString()
                      : '--'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// =============================================================================
// User Detail View
// =============================================================================

interface UserDetailViewProps {
  userId: string;
  userStats: ReturnType<typeof useUserStats>;
  onBack: () => void;
}

const UserDetailView: React.FC<UserDetailViewProps> = ({ userId, userStats, onBack }) => {
  const { data: stats, loading, error } = userStats;
  const userMetrics = useRecentMetrics({ userId, maxResults: 20 });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={16} />
        </Button>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">User Details</h2>
          <p className="text-sm text-slate-500 font-mono">{userId}</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
          Failed to load user stats: {error.message}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
        </div>
      ) : stats ? (
        <>
          {/* Lifetime Stats */}
          <div>
            <h3 className="text-sm font-medium text-slate-500 mb-3">Lifetime</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <StatCard
                label="Conversations"
                value={stats.lifetime.conversationsExisting.toString()}
                sublabel={`${stats.lifetime.conversationsCreated} created, ${stats.lifetime.conversationsDeleted} deleted`}
              />
              <StatCard
                label="Jobs"
                value={(stats.lifetime.jobsSucceeded + stats.lifetime.jobsFailed).toString()}
                sublabel={`${stats.lifetime.jobsSucceeded} success, ${stats.lifetime.jobsFailed} failed`}
              />
              <StatCard
                label="Audio Processed"
                value={`${stats.lifetime.audioHoursProcessed.toFixed(2)}h`}
              />
              <StatCard
                label="Estimated Cost"
                value={formatUsd(stats.lifetime.estimatedCostUsd)}
              />
            </div>
          </div>

          {/* Rolling Windows */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-sm font-medium text-slate-500 mb-3">Last 7 Days</h3>
              <div className="grid grid-cols-2 gap-4">
                <StatCard
                  label="Jobs"
                  value={(stats.last7Days.jobsSucceeded + stats.last7Days.jobsFailed).toString()}
                  size="sm"
                />
                <StatCard
                  label="Audio"
                  value={`${stats.last7Days.audioHoursProcessed.toFixed(2)}h`}
                  size="sm"
                />
              </div>
            </div>
            <div>
              <h3 className="text-sm font-medium text-slate-500 mb-3">Last 30 Days</h3>
              <div className="grid grid-cols-2 gap-4">
                <StatCard
                  label="Jobs"
                  value={(stats.last30Days.jobsSucceeded + stats.last30Days.jobsFailed).toString()}
                  size="sm"
                />
                <StatCard
                  label="Audio"
                  value={`${stats.last30Days.audioHoursProcessed.toFixed(2)}h`}
                  size="sm"
                />
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center text-slate-500 py-8">
          No stats available for this user
        </div>
      )}

      {/* User's Recent Jobs */}
      <div>
        <h3 className="text-sm font-medium text-slate-500 mb-3">Recent Jobs</h3>
        {userMetrics.loading ? (
          <MetricsTableSkeleton rows={5} />
        ) : (
          <MetricsTable
            metrics={userMetrics.data}
            title=""
            showUserId={false}
          />
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Jobs Tab
// =============================================================================

interface JobsTabProps {
  recentMetrics: ReturnType<typeof useRecentMetrics>;
  onJobClick?: (metricId: string) => void;
}

const JobsTab: React.FC<JobsTabProps> = ({ recentMetrics, onJobClick }) => {
  const { data: metrics, loading, error, refetch } = recentMetrics;

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
        Failed to load jobs: {error.message}
      </div>
    );
  }

  const handleRowClick = (metric: { id?: string }) => {
    if (onJobClick && metric.id) {
      onJobClick(metric.id);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Recent Processing Jobs</h2>
        <Button variant="ghost" size="sm" onClick={refetch} className="gap-2">
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {loading ? (
        <MetricsTableSkeleton rows={10} />
      ) : (
        <MetricsTable
          metrics={metrics}
          showUserId={true}
          onRowClick={handleRowClick}
        />
      )}
    </div>
  );
};

// =============================================================================
// Chat Tab
// =============================================================================

interface ChatTabProps {
  chatMetrics: ReturnType<typeof useChatMetrics>;
}

const ChatTab: React.FC<ChatTabProps> = ({ chatMetrics }) => {
  const { data: metrics, loading, error, refetch } = chatMetrics;

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
        Failed to load chat metrics: {error.message}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-slate-200 rounded w-1/4" />
        <div className="bg-white rounded-lg border border-slate-200 p-8">
          <div className="h-4 bg-slate-200 rounded w-full mb-4" />
          <div className="h-4 bg-slate-200 rounded w-3/4" />
        </div>
      </div>
    );
  }

  // Check if any metrics are missing pricing snapshots
  const hasMissingPricing = metrics.some(m => !m.pricingSnapshot);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Chat Activity</h2>
        <Button variant="ghost" size="sm" onClick={refetch} className="gap-2">
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      <ChatMetricsTable metrics={metrics} showPricingWarning={hasMissingPricing} />
    </div>
  );
};

// =============================================================================
// Quality Tab (Speaker Reconciliation)
// =============================================================================

const QualityTab: React.FC = () => {
  const { metrics, stats, flagsState, loading, error, refetch } = useReconciliationQuality({ maxResults: 100 });

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
        Failed to load quality metrics: {error.message}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 p-4 h-24" />
          ))}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-6 h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with controls */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Speaker Reconciliation Quality</h2>
          <p className="text-sm text-slate-500 mt-1">
            Context-aware reconciliation rollout status and metrics
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={refetch} className="gap-2">
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {/* Feature Flag Status Banner */}
      {flagsState && (
        <div className={`rounded-xl border p-4 ${
          flagsState.disabledAt
            ? 'bg-red-50 border-red-200'
            : flagsState.enableContextAwareReconciliation
            ? 'bg-green-50 border-green-200'
            : 'bg-slate-50 border-slate-200'
        }`}>
          <div className="flex items-center gap-3">
            {flagsState.disabledAt ? (
              <AlertTriangle className="text-red-600" size={20} />
            ) : flagsState.enableContextAwareReconciliation ? (
              <CheckCircle className="text-green-600" size={20} />
            ) : (
              <Shield className="text-slate-400" size={20} />
            )}
            <div className="flex-1">
              <p className={`font-medium ${
                flagsState.disabledAt
                  ? 'text-red-900'
                  : flagsState.enableContextAwareReconciliation
                  ? 'text-green-900'
                  : 'text-slate-700'
              }`}>
                {flagsState.disabledAt
                  ? 'Context-Aware Reconciliation Auto-Disabled'
                  : flagsState.enableContextAwareReconciliation
                  ? `Context-Aware Reconciliation Active (${flagsState.contextAwareRolloutPercentage}% rollout)`
                  : 'Context-Aware Reconciliation Disabled'}
              </p>
              {flagsState.disableReason && (
                <p className="text-sm text-red-700 mt-1">{flagsState.disableReason}</p>
              )}
              {flagsState.disabledAt && (
                <p className="text-xs text-red-600 mt-1">
                  Disabled at: {flagsState.disabledAt.toDate?.().toLocaleString() || 'Unknown'}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Reconciliations"
            value={stats.totalCount.toString()}
            sublabel={`${stats.contextAwareCount} context-aware, ${stats.embeddingOnlyCount} embedding-only`}
            icon={<Activity size={20} className="text-blue-500" />}
          />
          <StatCard
            label="Average Confidence"
            value={`${(stats.avgConfidence * 100).toFixed(1)}%`}
            sublabel={`${stats.lowConfidenceCount} below 65% threshold`}
            icon={stats.lowConfidenceCount > 0
              ? <AlertTriangle size={20} className="text-amber-500" />
              : <CheckCircle size={20} className="text-green-500" />}
          />
          <StatCard
            label="Warnings"
            value={stats.warningCount.toString()}
            sublabel={`${((stats.warningCount / Math.max(stats.totalCount, 1)) * 100).toFixed(1)}% of reconciliations`}
            icon={stats.warningCount > 0
              ? <AlertTriangle size={20} className="text-amber-500" />
              : <CheckCircle size={20} className="text-green-500" />}
          />
          <StatCard
            label="Average Latency"
            value={formatDuration(stats.avgLatencyMs)}
            sublabel={`P95: ${formatDuration(stats.p95LatencyMs)}`}
            icon={<Clock size={20} className="text-slate-400" />}
          />
        </div>
      )}

      {/* Strategy Breakdown */}
      {stats && stats.totalCount > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h3 className="text-sm font-medium text-slate-700 mb-4">Strategy Distribution</h3>
          <div className="flex gap-4">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-slate-600">Context-Aware</span>
                <span className="text-sm font-medium text-slate-900">
                  {stats.contextAwareCount} ({((stats.contextAwareCount / stats.totalCount) * 100).toFixed(1)}%)
                </span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${(stats.contextAwareCount / stats.totalCount) * 100}%` }}
                />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-slate-600">Embedding-Only</span>
                <span className="text-sm font-medium text-slate-900">
                  {stats.embeddingOnlyCount} ({((stats.embeddingOnlyCount / stats.totalCount) * 100).toFixed(1)}%)
                </span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-slate-400 transition-all duration-300"
                  style={{ width: `${(stats.embeddingOnlyCount / stats.totalCount) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recent Reconciliations Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h3 className="text-sm font-medium text-slate-700">Recent Reconciliations</h3>
        </div>
        {metrics.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            No reconciliation metrics recorded yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Time
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Conversation
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Strategy
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Clusters
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Confidence
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Latency
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {metrics.map((metric) => (
                  <tr key={metric.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                      {metric.timestamp?.toDate?.()?.toLocaleString() || '--'}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-900">
                      {metric.conversationId.slice(0, 12)}...
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        metric.strategy === 'context-aware'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-slate-100 text-slate-700'
                      }`}>
                        {metric.strategy}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      {metric.clusterCount}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={metric.confidence < 0.65 ? 'text-amber-600 font-medium' : 'text-slate-600'}>
                        {(metric.confidence * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      {formatDuration(metric.latencyMs)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {metric.hasWarning ? (
                        <AlertTriangle size={16} className="text-amber-500 inline" />
                      ) : (
                        <CheckCircle size={16} className="text-green-500 inline" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
