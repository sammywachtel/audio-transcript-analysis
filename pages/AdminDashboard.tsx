import React, { useState, useEffect } from 'react';
import { collection, query, orderBy, limit, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '../firebase-config';
import { Button } from '../components/Button';
import { ArrowLeft, Activity, Clock, CheckCircle2, XCircle, Loader2, User } from 'lucide-react';
import { formatTime } from '../utils';

interface AdminDashboardProps {
  onBack: () => void;
}

// Firestore Timestamp comes back as an object with seconds/nanoseconds
interface FirestoreTimestamp {
  seconds: number;
  nanoseconds: number;
  toDate?: () => Date;
}

interface MetricData {
  conversationId: string;
  success: boolean;
  timestamp: FirestoreTimestamp | null;
  userId?: string;
  errorMessage?: string;
  alignmentStatus?: 'aligned' | 'fallback' | 'pending';
  // Detailed timing breakdown (ms)
  timingMs?: {
    download: number;
    whisperx: number;
    buildSegments: number;
    gemini: number;
    speakerCorrection: number;
    transform: number;
    firestore: number;
    total: number;
  };
  // Result counts
  segmentCount?: number;
  speakerCount?: number;
  speakerCorrectionsApplied?: number;
}

/**
 * AdminDashboard - Observability metrics view for admin users
 *
 * Shows aggregate processing stats and recent job history from _metrics collection.
 * Server-side Cloud Functions write to _metrics after each processing job.
 * Simple table display - no fancy charts yet, just the data we need.
 */
// Helper to format Firestore timestamp to readable string
function formatTimestamp(ts: FirestoreTimestamp | null): string {
  if (!ts) return '--';
  // Firestore Timestamp has toDate() method, or we can use seconds
  if (ts.toDate) {
    return ts.toDate().toLocaleString();
  }
  // Fallback: construct from seconds
  return new Date(ts.seconds * 1000).toLocaleString();
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ onBack }) => {
  const [metrics, setMetrics] = useState<MetricData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        setLoading(true);
        setError(null);

        // Query _metrics collection - most recent first, limit to 50
        const metricsQuery = query(
          collection(db, '_metrics'),
          orderBy('timestamp', 'desc'),
          limit(50)
        );

        const snapshot = await getDocs(metricsQuery);
        const data: MetricData[] = [];

        snapshot.forEach((doc) => {
          const docData = doc.data();
          data.push({
            conversationId: docData.conversationId || doc.id,
            success: docData.status === 'success',
            timestamp: docData.timestamp,
            userId: docData.userId,
            errorMessage: docData.errorMessage,
            alignmentStatus: docData.alignmentStatus,
            timingMs: docData.timingMs,
            segmentCount: docData.segmentCount,
            speakerCount: docData.speakerCount,
            speakerCorrectionsApplied: docData.speakerCorrectionsApplied,
          });
        });

        setMetrics(data);
      } catch (err) {
        console.error('[AdminDashboard] Failed to fetch metrics:', err);
        setError('Failed to load metrics. Check console for details.');
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
  }, []);

  // Calculate aggregate stats
  const totalJobs = metrics.length;
  const successfulJobs = metrics.filter((m) => m.success).length;
  const failedJobs = totalJobs - successfulJobs;
  const successRate = totalJobs > 0 ? ((successfulJobs / totalJobs) * 100).toFixed(1) : '0';

  // Calculate average times from detailed timing data
  const metricsWithTiming = metrics.filter((m) => m.timingMs);
  const avgProcessingTime = metricsWithTiming.length > 0
    ? metricsWithTiming.reduce((sum, m) => sum + (m.timingMs?.total || 0), 0) / metricsWithTiming.length
    : 0;
  const avgGeminiTime = metricsWithTiming.length > 0
    ? metricsWithTiming.reduce((sum, m) => sum + (m.timingMs?.gemini || 0), 0) / metricsWithTiming.length
    : 0;
  const avgWhisperXTime = metricsWithTiming.length > 0
    ? metricsWithTiming.reduce((sum, m) => sum + (m.timingMs?.whisperx || 0), 0) / metricsWithTiming.length
    : 0;

  // Timestamp source stats (WhisperX vs Fallback)
  const alignedCount = metrics.filter((m) => m.alignmentStatus === 'aligned').length;
  const fallbackCount = metrics.filter((m) => m.alignmentStatus === 'fallback').length;

  // Speaker correction stats
  const totalCorrections = metrics.reduce((sum, m) => sum + (m.speakerCorrectionsApplied || 0), 0);

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

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={40} className="text-blue-500 animate-spin" />
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
            {error}
          </div>
        ) : (
          <>
            {/* Aggregate Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
              <StatCard
                icon={<Activity size={20} />}
                label="Total Jobs"
                value={totalJobs.toString()}
                color="blue"
              />
              <StatCard
                icon={<CheckCircle2 size={20} />}
                label="Success Rate"
                value={`${successRate}%`}
                color="emerald"
              />
              <StatCard
                icon={<Clock size={20} />}
                label="Avg Processing Time"
                value={formatTime(avgProcessingTime)}
                color="purple"
              />
              <StatCard
                icon={<XCircle size={20} />}
                label="Failed Jobs"
                value={failedJobs.toString()}
                color="red"
              />
            </div>

            {/* Processing Time Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <StatCard
                icon={<Clock size={20} />}
                label="Avg Gemini Analysis"
                value={formatTime(avgGeminiTime)}
                color="purple"
              />
              <StatCard
                icon={<Clock size={20} />}
                label="Avg WhisperX Time"
                value={formatTime(avgWhisperXTime)}
                color="blue"
              />
              <StatCard
                icon={<Activity size={20} />}
                label="Speaker Corrections"
                value={totalCorrections.toString()}
                color="amber"
              />
            </div>

            {/* Alignment Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
              <StatCard
                icon={<CheckCircle2 size={20} />}
                label="WhisperX Aligned"
                value={alignedCount.toString()}
                color="emerald"
              />
              <StatCard
                icon={<XCircle size={20} />}
                label="Timestamp Fallback"
                value={fallbackCount.toString()}
                color="amber"
              />
            </div>

            {/* Recent Jobs Table */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200">
                <h2 className="font-semibold text-slate-900">Recent Processing Jobs</h2>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                      <th className="px-6 py-3">Timestamp</th>
                      <th className="px-6 py-3">User ID</th>
                      <th className="px-6 py-3">Conversation ID</th>
                      <th className="px-6 py-3">Status</th>
                      <th className="px-6 py-3">Processing Time</th>
                      <th className="px-6 py-3">Alignment</th>
                      <th className="px-6 py-3">Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {metrics.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                          No metrics data available yet
                        </td>
                      </tr>
                    ) : (
                      metrics.map((metric) => (
                        <tr key={metric.conversationId} className="hover:bg-slate-50">
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {formatTimestamp(metric.timestamp)}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600 font-mono">
                            {metric.userId ? metric.userId.substring(0, 8) + '...' : '--'}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-900 font-mono">
                            {metric.conversationId.substring(0, 12)}...
                          </td>
                          <td className="px-6 py-4">
                            {metric.success ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                                <CheckCircle2 size={12} />
                                Success
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                                <XCircle size={12} />
                                Failed
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {metric.timingMs?.total ? formatTime(metric.timingMs.total) : '--'}
                          </td>
                          <td className="px-6 py-4">
                            {metric.alignmentStatus === 'aligned' ? (
                              <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                                WhisperX
                              </span>
                            ) : metric.alignmentStatus === 'fallback' ? (
                              <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                                Fallback
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">--</span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-red-600">
                            {metric.errorMessage || '--'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// Helper component for stat cards
interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'blue' | 'emerald' | 'purple' | 'red' | 'amber';
}

const StatCard: React.FC<StatCardProps> = ({ icon, label, value, color }) => {
  const colorClasses = {
    blue: 'bg-blue-100 text-blue-600',
    emerald: 'bg-emerald-100 text-emerald-600',
    purple: 'bg-purple-100 text-purple-600',
    red: 'bg-red-100 text-red-600',
    amber: 'bg-amber-100 text-amber-600',
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
      <div className="flex items-center gap-3 mb-2">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colorClasses[color]}`}>
          {icon}
        </div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{label}</div>
      </div>
      <div className="text-2xl font-bold text-slate-900">{value}</div>
    </div>
  );
};
