/**
 * CostReconciliationReport - Comprehensive cost analysis report
 *
 * Accessible at `/admin/reports/cost-reconciliation`
 *
 * Shows TWO types of cost analysis:
 *
 * 1. ACTUAL BILLING (Gemini only):
 *    - Compares estimated Gemini cost vs actual cost from BigQuery billing exports
 *    - Requires billing sync to populate actualCost in _metrics documents
 *    - Only covers Gemini/Vertex AI (WhisperX billing not available via BigQuery)
 *
 * 2. RATE VARIANCE (all services):
 *    - Compares costs calculated at processing time vs current configured rates
 *    - Detects when you've updated pricing in _pricing collection
 *    - Covers Gemini, WhisperX, and Chat costs
 */

import React, { useState, useMemo } from 'react';
import { Button } from '../components/Button';
import { ArrowLeft, Download, Calendar, TrendingUp, TrendingDown, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import {
  ProcessingMetric,
  ChatMetric,
  PricingConfig,
  formatUsd,
  recalculateCostBreakdownSync,
  calculateCostSummary,
  calculateCostVariance
} from '../services/metricsService';
import { cn } from '../utils';

interface CostReconciliationReportProps {
  metrics: (ProcessingMetric | ChatMetric)[];
  pricingConfigs: PricingConfig[];
  onBack: () => void;
}

type ViewMode = 'billing' | 'rate-variance';
type PeriodMode = 'daily' | 'weekly' | 'monthly';

interface BillingSummary {
  period: string;
  jobCount: number;
  jobsWithActual: number;
  estimatedGemini: number;
  actualGemini: number;
  variance: number;
  variancePercent: number;
  estimatedTotal: number;  // Includes WhisperX etc
}

interface RateVarianceSummary {
  period: string;
  service: string;
  jobCount: number;
  estimatedCost: number;
  recalculatedCost: number;
  variance: number;
  variancePercent: number;
  hasPricing: boolean;
}

export const CostReconciliationReport: React.FC<CostReconciliationReportProps> = ({
  metrics,
  pricingConfigs,
  onBack
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('billing');
  const [periodMode, setPeriodMode] = useState<PeriodMode>('weekly');
  const [dateRange, setDateRange] = useState(30);

  // Filter to processing metrics only (chat metrics don't have actualCost)
  const processingMetrics = useMemo(() =>
    metrics.filter((m): m is ProcessingMetric => !('type' in m) || m.type !== 'chat'),
    [metrics]
  );

  // Filter by date range
  const filteredMetrics = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - dateRange);
    return processingMetrics.filter(m => {
      const timestamp = m.timestamp.toDate?.() || new Date(m.timestamp as unknown as string);
      return timestamp >= cutoff;
    });
  }, [processingMetrics, dateRange]);

  // Overall cost summary
  const overallSummary = useMemo(() =>
    calculateCostSummary(filteredMetrics),
    [filteredMetrics]
  );

  // Get period key for a timestamp
  const getPeriodKey = (timestamp: Date): string => {
    if (periodMode === 'daily') {
      return timestamp.toISOString().split('T')[0];
    } else if (periodMode === 'weekly') {
      const weekStart = new Date(timestamp);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      return weekStart.toISOString().split('T')[0];
    } else {
      return `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, '0')}`;
    }
  };

  // Billing summaries (actual vs estimated)
  const billingSummaries = useMemo(() => {
    const periodMap = new Map<string, BillingSummary>();

    filteredMetrics.forEach(metric => {
      const timestamp = metric.timestamp.toDate?.() || new Date(metric.timestamp as unknown as string);
      const periodKey = getPeriodKey(timestamp);

      if (!periodMap.has(periodKey)) {
        periodMap.set(periodKey, {
          period: periodKey,
          jobCount: 0,
          jobsWithActual: 0,
          estimatedGemini: 0,
          actualGemini: 0,
          variance: 0,
          variancePercent: 0,
          estimatedTotal: 0
        });
      }

      const summary = periodMap.get(periodKey)!;
      summary.jobCount++;
      summary.estimatedTotal += metric.estimatedCost?.totalUsd || 0;
      summary.estimatedGemini += metric.estimatedCost?.geminiUsd || 0;

      if (metric.actualCost?.geminiUsd) {
        summary.jobsWithActual++;
        summary.actualGemini += metric.actualCost.geminiUsd;
      }
    });

    // Calculate variances
    periodMap.forEach(summary => {
      summary.variance = summary.actualGemini - summary.estimatedGemini;
      summary.variancePercent = summary.estimatedGemini > 0
        ? (summary.variance / summary.estimatedGemini) * 100
        : 0;
    });

    return Array.from(periodMap.values()).sort((a, b) => b.period.localeCompare(a.period));
  }, [filteredMetrics, periodMode]);

  // Rate variance summaries (recalculated vs estimated)
  const rateVarianceSummaries = useMemo(() => {
    const periodMap = new Map<string, Map<string, RateVarianceSummary>>();

    metrics.forEach(metric => {
      const timestamp = metric.timestamp.toDate?.() || new Date(metric.timestamp as unknown as string);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - dateRange);
      if (timestamp < cutoff) return;

      const periodKey = getPeriodKey(timestamp);
      const recalculated = recalculateCostBreakdownSync(metric, pricingConfigs);

      if ('type' in metric && metric.type === 'chat') {
        updateRateVariance(periodMap, periodKey, 'chat', metric.costUsd, recalculated.chatUsd, recalculated.foundChatPricing);
      } else {
        const pm = metric as ProcessingMetric;
        if (pm.estimatedCost) {
          if (pm.llmUsage?.geminiAnalysis) {
            updateRateVariance(periodMap, periodKey, 'gemini', pm.estimatedCost.geminiUsd, recalculated.geminiUsd, recalculated.foundGeminiPricing);
          }
          if (pm.llmUsage?.whisperx) {
            // WhisperX now includes diarization - no separate diarizationUsd field
            updateRateVariance(periodMap, periodKey, 'whisperx', pm.estimatedCost.whisperxUsd, recalculated.whisperxUsd, recalculated.foundWhisperxPricing);
          }
        }
      }
    });

    function updateRateVariance(
      map: Map<string, Map<string, RateVarianceSummary>>,
      period: string,
      service: string,
      estimated: number,
      recalculated: number,
      hasPricing: boolean
    ) {
      if (!map.has(period)) map.set(period, new Map());
      const serviceMap = map.get(period)!;

      if (!serviceMap.has(service)) {
        serviceMap.set(service, {
          period, service, jobCount: 0, estimatedCost: 0, recalculatedCost: 0,
          variance: 0, variancePercent: 0, hasPricing: true
        });
      }

      const s = serviceMap.get(service)!;
      s.jobCount++;
      s.estimatedCost += estimated;
      s.recalculatedCost += recalculated;
      s.variance = s.recalculatedCost - s.estimatedCost;
      s.variancePercent = s.estimatedCost > 0 ? (s.variance / s.estimatedCost) * 100 : 0;
      if (!hasPricing) s.hasPricing = false;
    }

    const result: RateVarianceSummary[] = [];
    periodMap.forEach(serviceMap => serviceMap.forEach(s => result.push(s)));
    return result.sort((a, b) => b.period.localeCompare(a.period) || a.service.localeCompare(b.service));
  }, [metrics, pricingConfigs, dateRange, periodMode]);

  // Export CSV
  const handleExportCsv = () => {
    if (viewMode === 'billing') {
      const headers = ['Period', 'Jobs', 'Jobs with Actual', 'Estimated Gemini', 'Actual Gemini', 'Variance', 'Variance %'];
      const rows = billingSummaries.map(s => [
        s.period, s.jobCount, s.jobsWithActual,
        s.estimatedGemini.toFixed(6), s.actualGemini.toFixed(6),
        s.variance.toFixed(6), s.variancePercent.toFixed(2)
      ]);
      downloadCsv([headers, ...rows], `billing-reconciliation-${new Date().toISOString().split('T')[0]}.csv`);
    } else {
      const headers = ['Period', 'Service', 'Jobs', 'Estimated', 'Recalculated', 'Variance', 'Variance %'];
      const rows = rateVarianceSummaries.map(s => [
        s.period, s.service, s.jobCount,
        s.estimatedCost.toFixed(6), s.recalculatedCost.toFixed(6),
        s.variance.toFixed(6), s.variancePercent.toFixed(2)
      ]);
      downloadCsv([headers, ...rows], `rate-variance-${new Date().toISOString().split('T')[0]}.csv`);
    }
  };

  const downloadCsv = (data: (string | number)[][], filename: string) => {
    const csv = data.map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const overallVariance = calculateCostVariance(overallSummary.actual, overallSummary.estimated);

  return (
    <div className="min-h-screen bg-slate-50 p-6 md:p-12">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" onClick={onBack} className="gap-2">
              <ArrowLeft size={18} />
              Back
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Cost Reconciliation</h1>
              <p className="text-slate-500 mt-1">Compare estimated vs actual billing costs</p>
            </div>
          </div>
          <Button onClick={handleExportCsv} className="gap-2">
            <Download size={16} />
            Export CSV
          </Button>
        </div>

        {/* View Mode Tabs */}
        <div className="flex gap-2 border-b border-slate-200">
          <button
            onClick={() => setViewMode('billing')}
            className={cn(
              'px-4 py-2.5 text-sm font-medium transition-colors -mb-px',
              viewMode === 'billing'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            Actual Billing
          </button>
          <button
            onClick={() => setViewMode('rate-variance')}
            className={cn(
              'px-4 py-2.5 text-sm font-medium transition-colors -mb-px',
              viewMode === 'rate-variance'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            Rate Variance
          </button>
        </div>

        {viewMode === 'billing' ? (
          <>
            {/* Billing Overview Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <p className="text-xs text-slate-500 font-medium mb-1">Estimated (Gemini)</p>
                <p className="text-2xl font-bold text-slate-900">{formatUsd(overallSummary.estimated)}</p>
                <p className="text-xs text-slate-400 mt-1">Calculated at processing time</p>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <p className="text-xs text-slate-500 font-medium mb-1">Actual (BigQuery)</p>
                <p className="text-2xl font-bold text-emerald-600">{formatUsd(overallSummary.actual)}</p>
                <p className="text-xs text-slate-400 mt-1">From GCP billing exports</p>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <p className="text-xs text-slate-500 font-medium mb-1">Variance</p>
                <div className="flex items-center gap-2">
                  {overallVariance.status === 'over' ? (
                    <TrendingUp size={20} className="text-red-500" />
                  ) : overallVariance.status === 'under' ? (
                    <TrendingDown size={20} className="text-green-500" />
                  ) : (
                    <CheckCircle size={20} className="text-emerald-500" />
                  )}
                  <p className={cn(
                    'text-2xl font-bold',
                    overallVariance.status === 'over' ? 'text-red-600' :
                    overallVariance.status === 'under' ? 'text-green-600' : 'text-slate-900'
                  )}>
                    {overallVariance.absolute >= 0 ? '+' : ''}{formatUsd(overallVariance.absolute)}
                  </p>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {overallVariance.percentage >= 0 ? '+' : ''}{overallVariance.percentage.toFixed(1)}% difference
                </p>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <p className="text-xs text-slate-500 font-medium mb-1">Billing Coverage</p>
                <p className="text-2xl font-bold text-slate-900">{overallSummary.actualCoverage.toFixed(0)}%</p>
                <p className="text-xs text-slate-400 mt-1">
                  {overallSummary.jobsWithActual} of {overallSummary.totalJobs} jobs synced
                </p>
              </div>
            </div>

            {/* Info Banner */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertCircle size={18} className="text-blue-600 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-blue-800">
                  <p className="font-medium">About Actual Billing Data</p>
                  <p className="mt-1">
                    Actual costs are synced from Google Cloud BigQuery billing exports. This only covers
                    <strong> Gemini/Vertex AI</strong> costs — WhisperX (Replicate) costs aren't available via BigQuery.
                    Billing data typically has a 24-48 hour delay.
                  </p>
                </div>
              </div>
            </div>

            {/* Controls */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Calendar size={16} className="text-slate-400" />
                <span className="text-sm text-slate-600">Period:</span>
                <select
                  value={periodMode}
                  onChange={(e) => setPeriodMode(e.target.value as PeriodMode)}
                  className="text-sm border border-slate-300 rounded-lg px-3 py-1.5"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">Range:</span>
                <select
                  value={dateRange}
                  onChange={(e) => setDateRange(Number(e.target.value))}
                  className="text-sm border border-slate-300 rounded-lg px-3 py-1.5"
                >
                  <option value={7}>Last 7 days</option>
                  <option value={14}>Last 14 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              </div>
            </div>

            {/* Billing Table */}
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
                <h2 className="text-sm font-medium text-slate-700">Billing by Period</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Period</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Jobs</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Synced</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Estimated</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Actual</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Variance</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {billingSummaries.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                          No data available for selected date range
                        </td>
                      </tr>
                    ) : (
                      billingSummaries.map((s, idx) => {
                        const variance = calculateCostVariance(s.actualGemini, s.estimatedGemini);
                        const coverage = s.jobCount > 0 ? (s.jobsWithActual / s.jobCount) * 100 : 0;

                        return (
                          <tr key={`${s.period}-${idx}`} className="hover:bg-slate-50">
                            <td className="px-4 py-3 font-medium text-slate-900">{s.period}</td>
                            <td className="px-4 py-3 text-right text-slate-600">{s.jobCount}</td>
                            <td className="px-4 py-3 text-right">
                              <span className={cn(
                                'text-xs',
                                coverage >= 80 ? 'text-emerald-600' : coverage >= 50 ? 'text-amber-600' : 'text-slate-400'
                              )}>
                                {s.jobsWithActual}/{s.jobCount}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-slate-900">
                              {formatUsd(s.estimatedGemini)}
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-emerald-600">
                              {s.jobsWithActual > 0 ? formatUsd(s.actualGemini) : '—'}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {s.jobsWithActual > 0 ? (
                                <div className="flex items-center justify-end gap-1">
                                  {variance.status === 'over' ? (
                                    <TrendingUp size={14} className="text-red-500" />
                                  ) : variance.status === 'under' ? (
                                    <TrendingDown size={14} className="text-green-500" />
                                  ) : null}
                                  <span className={cn(
                                    'font-mono',
                                    variance.status === 'over' ? 'text-red-600' :
                                    variance.status === 'under' ? 'text-green-600' : 'text-slate-600'
                                  )}>
                                    {s.variance >= 0 ? '+' : ''}{formatUsd(s.variance)}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {s.jobsWithActual === 0 ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                                  <Clock size={12} /> Pending
                                </span>
                              ) : variance.status === 'match' ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                                  ✓ Match
                                </span>
                              ) : variance.status === 'over' ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                                  ↑ Over
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
                                  ↓ Under
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Rate Variance View */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertCircle size={18} className="text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-amber-800">
                  <p className="font-medium">About Rate Variance</p>
                  <p className="mt-1">
                    This compares costs calculated at processing time vs costs recalculated using your
                    <strong> current pricing configuration</strong>. Variance indicates your configured rates
                    have changed — not actual billing discrepancies.
                  </p>
                </div>
              </div>
            </div>

            {/* Controls */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Calendar size={16} className="text-slate-400" />
                <span className="text-sm text-slate-600">Period:</span>
                <select
                  value={periodMode}
                  onChange={(e) => setPeriodMode(e.target.value as PeriodMode)}
                  className="text-sm border border-slate-300 rounded-lg px-3 py-1.5"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">Range:</span>
                <select
                  value={dateRange}
                  onChange={(e) => setDateRange(Number(e.target.value))}
                  className="text-sm border border-slate-300 rounded-lg px-3 py-1.5"
                >
                  <option value={7}>Last 7 days</option>
                  <option value={14}>Last 14 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              </div>
            </div>

            {/* Rate Variance Table */}
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
                <h2 className="text-sm font-medium text-slate-700">Rate Variance by Period & Service</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Period</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Service</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Jobs</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Estimated</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Recalculated</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Variance</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rateVarianceSummaries.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                          No data available for selected date range
                        </td>
                      </tr>
                    ) : (
                      rateVarianceSummaries.map((s, idx) => {
                        const isSignificant = s.hasPricing && Math.abs(s.variancePercent) > 5;

                        return (
                          <tr
                            key={`${s.period}-${s.service}-${idx}`}
                            className={cn('hover:bg-slate-50', isSignificant && 'bg-red-50')}
                          >
                            <td className="px-4 py-3 font-medium text-slate-900">{s.period}</td>
                            <td className="px-4 py-3 text-slate-700 capitalize">{s.service}</td>
                            <td className="px-4 py-3 text-right text-slate-600">{s.jobCount}</td>
                            <td className="px-4 py-3 text-right font-mono text-slate-900">
                              {formatUsd(s.estimatedCost)}
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-slate-900">
                              {formatUsd(s.recalculatedCost)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {s.variance > 0 ? (
                                  <TrendingUp size={14} className="text-red-500" />
                                ) : s.variance < 0 ? (
                                  <TrendingDown size={14} className="text-green-500" />
                                ) : null}
                                <span className={cn(
                                  'font-mono',
                                  s.variance > 0 ? 'text-red-600' : s.variance < 0 ? 'text-green-600' : 'text-slate-600'
                                )}>
                                  {s.variance >= 0 ? '+' : ''}{formatUsd(s.variance)}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right">
                              {!s.hasPricing ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                                  No pricing
                                </span>
                              ) : isSignificant ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                                  ❌ Changed
                                </span>
                              ) : Math.abs(s.variancePercent) > 1 ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
                                  ⚠️ Minor
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                                  ✓ Match
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
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
