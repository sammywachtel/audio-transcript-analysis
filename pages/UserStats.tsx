/**
 * UserStats - Personal usage statistics page
 *
 * Shows the current user's own usage metrics:
 * - Lifetime totals (conversations, audio hours, estimated costs)
 * - Rolling window stats (7-day, 30-day)
 * - Recent processing job history
 *
 * Accessible to all authenticated users, not just admins.
 */

import React from 'react';
import { Button } from '../components/Button';
import { ArrowLeft, Loader2, FileAudio, Clock, DollarSign, Activity, BarChart3 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useMyStats, useRecentMetrics } from '../hooks/useMetrics';
import {
  StatCard,
  StatCardSkeleton,
  MetricsTable,
  MetricsTableSkeleton
} from '../components/metrics';
import { formatUsd } from '../services/metricsService';

interface UserStatsProps {
  onBack: () => void;
}

export const UserStats: React.FC<UserStatsProps> = ({ onBack }) => {
  const { user } = useAuth();
  const { data: stats, loading: statsLoading, error: statsError, refetch } = useMyStats();
  const { data: recentMetrics, loading: metricsLoading } = useRecentMetrics({
    maxResults: 20
  });

  return (
    <div className="min-h-screen bg-slate-50 p-6 md:p-12">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">My Usage Stats</h1>
            <p className="text-slate-500 mt-1">Your personal usage metrics and processing history</p>
          </div>
          <Button variant="ghost" onClick={onBack} className="gap-2">
            <ArrowLeft size={18} />
            Back to Library
          </Button>
        </div>

        {statsError && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-amber-700 mb-6">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 size={20} />
              <span className="font-medium">Stats not available yet</span>
            </div>
            <p className="text-sm">
              Usage statistics will appear here after you've processed your first audio file.
              Upload an audio file to get started!
            </p>
          </div>
        )}

        {!statsError && (
          <div className="space-y-8">
            {/* Lifetime Stats */}
            <section>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Lifetime Totals</h2>
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
                      label="Conversations"
                      value={stats.lifetime.conversationsExisting.toString()}
                      sublabel={`${stats.lifetime.conversationsCreated} created, ${stats.lifetime.conversationsDeleted} deleted`}
                      icon={<FileAudio size={20} className="text-blue-500" />}
                    />
                    <StatCard
                      label="Processing Jobs"
                      value={(stats.lifetime.jobsSucceeded + stats.lifetime.jobsFailed).toString()}
                      sublabel={stats.lifetime.jobsFailed > 0
                        ? `${stats.lifetime.jobsSucceeded} succeeded, ${stats.lifetime.jobsFailed} failed`
                        : 'All successful'
                      }
                      icon={<Activity size={20} className="text-emerald-500" />}
                    />
                    <StatCard
                      label="Audio Processed"
                      value={`${stats.lifetime.audioHoursProcessed.toFixed(2)}h`}
                      sublabel={`${stats.lifetime.totalAudioFiles} audio files`}
                      icon={<Clock size={20} className="text-purple-500" />}
                    />
                    <StatCard
                      label="Estimated Cost"
                      value={formatUsd(stats.lifetime.estimatedCostUsd)}
                      sublabel="LLM processing costs"
                      icon={<DollarSign size={20} className="text-amber-500" />}
                    />
                  </>
                ) : (
                  <div className="col-span-4 text-center text-slate-500 py-8 bg-white rounded-lg border border-slate-200">
                    No usage data available yet
                  </div>
                )}
              </div>
            </section>

            {/* Rolling Window Stats */}
            {stats && (
              <section>
                <h2 className="text-lg font-semibold text-slate-900 mb-4">Activity Summary</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Last 7 Days */}
                  <div className="bg-white rounded-xl border border-slate-200 p-6">
                    <h3 className="text-sm font-medium text-slate-500 mb-4">Last 7 Days</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-2xl font-bold text-slate-900">
                          {stats.last7Days.jobsSucceeded + stats.last7Days.jobsFailed}
                        </p>
                        <p className="text-sm text-slate-500">Jobs processed</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-slate-900">
                          {stats.last7Days.audioHoursProcessed.toFixed(2)}h
                        </p>
                        <p className="text-sm text-slate-500">Audio time</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-slate-900">
                          {stats.last7Days.conversationsCreated}
                        </p>
                        <p className="text-sm text-slate-500">Conversations created</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-slate-900">
                          {formatUsd(stats.last7Days.estimatedCostUsd)}
                        </p>
                        <p className="text-sm text-slate-500">Est. cost</p>
                      </div>
                    </div>
                  </div>

                  {/* Last 30 Days */}
                  <div className="bg-white rounded-xl border border-slate-200 p-6">
                    <h3 className="text-sm font-medium text-slate-500 mb-4">Last 30 Days</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-2xl font-bold text-slate-900">
                          {stats.last30Days.jobsSucceeded + stats.last30Days.jobsFailed}
                        </p>
                        <p className="text-sm text-slate-500">Jobs processed</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-slate-900">
                          {stats.last30Days.audioHoursProcessed.toFixed(2)}h
                        </p>
                        <p className="text-sm text-slate-500">Audio time</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-slate-900">
                          {stats.last30Days.conversationsCreated}
                        </p>
                        <p className="text-sm text-slate-500">Conversations created</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-slate-900">
                          {formatUsd(stats.last30Days.estimatedCostUsd)}
                        </p>
                        <p className="text-sm text-slate-500">Est. cost</p>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Account Info */}
            {stats && (
              <section className="bg-white rounded-xl border border-slate-200 p-6">
                <h3 className="text-sm font-medium text-slate-500 mb-3">Account Activity</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-slate-500">User ID</p>
                    <p className="font-mono text-slate-900">{user?.uid?.slice(0, 16)}...</p>
                  </div>
                  <div>
                    <p className="text-slate-500">First Activity</p>
                    <p className="text-slate-900">
                      {stats.firstActivityAt?.toDate?.()
                        ? stats.firstActivityAt.toDate().toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                          })
                        : '--'}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">Last Activity</p>
                    <p className="text-slate-900">
                      {stats.lastActivityAt?.toDate?.()
                        ? stats.lastActivityAt.toDate().toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                          })
                        : '--'}
                    </p>
                  </div>
                </div>
              </section>
            )}

            {/* Recent Processing Jobs */}
            <section>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Recent Processing Jobs</h2>
              {metricsLoading ? (
                <MetricsTableSkeleton rows={5} />
              ) : recentMetrics.length > 0 ? (
                <MetricsTable
                  metrics={recentMetrics}
                  showUserId={false}
                />
              ) : (
                <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-500">
                  No processing jobs yet. Upload an audio file to get started!
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
};
