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
import { ArrowLeft, Activity, Users, Loader2, DollarSign, TrendingUp, Clock, FileAudio, RefreshCw } from 'lucide-react';
import { formatTime } from '../utils';

// Hooks
import {
  useGlobalStats,
  useDailyStats,
  useAllUserStatsSummaries,
  useRecentMetrics,
  useUserStats
} from '../hooks/useMetrics';

// Components
import {
  StatCard,
  StatCardSkeleton,
  TimeSeriesChart,
  TimeSeriesChartSkeleton,
  LLMUsageList,
  MetricsTable,
  MetricsTableSkeleton
} from '../components/metrics';
import { formatDuration, formatUsd } from '../services/metricsService';
import { PricingManager } from '../components/admin/PricingManager';

interface AdminDashboardProps {
  onBack: () => void;
}

type TabId = 'overview' | 'users' | 'jobs' | 'pricing';

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ onBack }) => {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState(30); // Last N days

  // Data hooks
  const globalStats = useGlobalStats();
  const dailyStats = useDailyStats({ days: dateRange });
  const userSummaries = useAllUserStatsSummaries(100);
  const recentMetrics = useRecentMetrics({ maxResults: 50 });

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <Activity size={16} /> },
    { id: 'users', label: 'Users', icon: <Users size={16} /> },
    { id: 'jobs', label: 'Jobs', icon: <Clock size={16} /> },
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
          <JobsTab recentMetrics={recentMetrics} />
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
  dateRange: number;
  onDateRangeChange: (days: number) => void;
}

const OverviewTab: React.FC<OverviewTabProps> = ({
  globalStats,
  dailyStats,
  dateRange,
  onDateRangeChange
}) => {
  const { data: stats, loading: statsLoading, error: statsError, refetch: refetchStats } = globalStats;
  const { data: daily, loading: dailyLoading, refetch: refetchDaily } = dailyStats;

  const handleRefresh = () => {
    refetchStats();
    refetchDaily();
  };

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
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="gap-2">
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

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
            <StatCard
              label="Total Cost"
              value={formatUsd(stats.llmUsage.estimatedTotalCostUsd)}
              sublabel="Estimated LLM costs"
              icon={<DollarSign size={20} className="text-amber-500" />}
            />
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
}

const JobsTab: React.FC<JobsTabProps> = ({ recentMetrics }) => {
  const { data: metrics, loading, error, refetch } = recentMetrics;

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
        Failed to load jobs: {error.message}
      </div>
    );
  }

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
        />
      )}
    </div>
  );
};
