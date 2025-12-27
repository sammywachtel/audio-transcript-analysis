/**
 * PricingManager - Admin UI for managing LLM pricing configuration
 *
 * Displays current and historical pricing records, with ability to add new
 * pricing effective dates. Supports both token-based (Gemini) and
 * time-based (Replicate/WhisperX) pricing models.
 *
 * Note: Records cannot be deleted (audit trail), only superseded by
 * new effective dates.
 */

import React, { useState } from 'react';
import { collection, addDoc, Timestamp } from 'firebase/firestore';
import { db } from '../../firebase-config';
import { Button } from '../Button';
import { usePricingConfigs } from '../../hooks/useMetrics';
import { PricingConfig, formatUsd } from '../../services/metricsService';
import { Plus, X, Loader2, DollarSign, RefreshCw, AlertCircle } from 'lucide-react';
import { cn } from '../../utils';

interface PricingManagerProps {
  className?: string;
}

export const PricingManager: React.FC<PricingManagerProps> = ({ className }) => {
  const { data: configs, loading, error, refetch } = usePricingConfigs();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    model: '',
    service: 'gemini' as 'gemini' | 'replicate',
    inputPricePerMillion: '',
    outputPricePerMillion: '',
    pricePerSecond: '',
    effectiveFrom: new Date().toISOString().split('T')[0],
    notes: ''
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);

    // Validate
    if (!formData.model.trim()) {
      setSaveError('Model name is required');
      return;
    }

    if (formData.service === 'gemini') {
      if (!formData.inputPricePerMillion && !formData.outputPricePerMillion) {
        setSaveError('At least one token price is required for Gemini');
        return;
      }
    } else {
      if (!formData.pricePerSecond) {
        setSaveError('Price per second is required for Replicate');
        return;
      }
    }

    try {
      setIsSaving(true);

      const pricingDoc: Omit<PricingConfig, 'pricingId'> = {
        model: formData.model.trim(),
        service: formData.service,
        effectiveFrom: Timestamp.fromDate(new Date(formData.effectiveFrom)),
        notes: formData.notes.trim() || undefined,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now()
      };

      // Add pricing fields based on service type
      if (formData.service === 'gemini') {
        if (formData.inputPricePerMillion) {
          pricingDoc.inputPricePerMillion = parseFloat(formData.inputPricePerMillion);
        }
        if (formData.outputPricePerMillion) {
          pricingDoc.outputPricePerMillion = parseFloat(formData.outputPricePerMillion);
        }
      } else {
        pricingDoc.pricePerSecond = parseFloat(formData.pricePerSecond);
      }

      await addDoc(collection(db, '_pricing'), pricingDoc);

      // Reset form and refetch
      setFormData({
        model: '',
        service: 'gemini',
        inputPricePerMillion: '',
        outputPricePerMillion: '',
        pricePerSecond: '',
        effectiveFrom: new Date().toISOString().split('T')[0],
        notes: ''
      });
      setIsFormOpen(false);
      refetch();

    } catch (err) {
      console.error('[PricingManager] Failed to save pricing:', err);
      setSaveError('Failed to save pricing configuration');
    } finally {
      setIsSaving(false);
    }
  };

  // Group configs by model
  const configsByModel = configs.reduce((acc, config) => {
    if (!acc[config.model]) {
      acc[config.model] = [];
    }
    acc[config.model].push(config);
    return acc;
  }, {} as Record<string, PricingConfig[]>);

  return (
    <div className={cn('space-y-6', className)}>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Pricing Configuration</h2>
          <p className="text-sm text-slate-500 mt-1">
            Manage LLM pricing for cost estimation. Add new records to update pricing - records cannot be deleted (audit trail).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={refetch}>
            <RefreshCw size={14} />
          </Button>
          <Button size="sm" onClick={() => setIsFormOpen(true)} className="gap-2">
            <Plus size={14} />
            Add Pricing
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          Failed to load pricing: {error.message}
        </div>
      )}

      {/* Add Pricing Form */}
      {isFormOpen && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-slate-900">Add New Pricing</h3>
            <button onClick={() => setIsFormOpen(false)} className="text-slate-400 hover:text-slate-600">
              <X size={20} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Model Name
                </label>
                <input
                  type="text"
                  value={formData.model}
                  onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                  placeholder="e.g., gemini-2.5-flash"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Service
                </label>
                <select
                  value={formData.service}
                  onChange={(e) => setFormData({ ...formData, service: e.target.value as 'gemini' | 'replicate' })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="gemini">Gemini (token-based)</option>
                  <option value="replicate">Replicate (time-based)</option>
                </select>
              </div>
            </div>

            {formData.service === 'gemini' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Input Price ($/1M tokens)
                  </label>
                  <input
                    type="number"
                    step="0.001"
                    value={formData.inputPricePerMillion}
                    onChange={(e) => setFormData({ ...formData, inputPricePerMillion: e.target.value })}
                    placeholder="e.g., 0.075"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Output Price ($/1M tokens)
                  </label>
                  <input
                    type="number"
                    step="0.001"
                    value={formData.outputPricePerMillion}
                    onChange={(e) => setFormData({ ...formData, outputPricePerMillion: e.target.value })}
                    placeholder="e.g., 0.30"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Price per Second ($)
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={formData.pricePerSecond}
                  onChange={(e) => setFormData({ ...formData, pricePerSecond: e.target.value })}
                  placeholder="e.g., 0.0023"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Effective From
                </label>
                <input
                  type="date"
                  value={formData.effectiveFrom}
                  onChange={(e) => setFormData({ ...formData, effectiveFrom: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Notes (optional)
                </label>
                <input
                  type="text"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="e.g., Price increase Jan 2025"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {saveError && (
              <div className="flex items-center gap-2 text-red-600 text-sm">
                <AlertCircle size={14} />
                {saveError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setIsFormOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 size={14} className="animate-spin mr-2" />
                    Saving...
                  </>
                ) : (
                  'Save Pricing'
                )}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Pricing Table */}
      {loading ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
          <Loader2 size={24} className="animate-spin text-blue-500 mx-auto" />
        </div>
      ) : configs.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
          <DollarSign size={40} className="text-slate-300 mx-auto mb-4" />
          <p className="text-slate-500">No pricing configurations yet</p>
          <p className="text-sm text-slate-400 mt-1">Add pricing to enable cost estimation</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(configsByModel).map(([model, modelConfigs]) => (
            <div key={model} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
                <span className="font-mono text-sm font-medium text-slate-900">{model}</span>
                <span className={cn(
                  'ml-2 px-2 py-0.5 rounded text-xs font-medium',
                  modelConfigs[0].service === 'gemini'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-purple-100 text-purple-700'
                )}>
                  {modelConfigs[0].service}
                </span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Effective From</th>
                    {modelConfigs[0].service === 'gemini' ? (
                      <>
                        <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">Input ($/1M)</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">Output ($/1M)</th>
                      </>
                    ) : (
                      <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">$/second</th>
                    )}
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {modelConfigs.map((config, idx) => (
                    <tr key={config.pricingId} className={idx === 0 ? 'bg-green-50/50' : ''}>
                      <td className="px-4 py-2 text-slate-600">
                        {config.effectiveFrom?.toDate?.()
                          ? config.effectiveFrom.toDate().toLocaleDateString()
                          : '--'}
                        {idx === 0 && (
                          <span className="ml-2 text-xs text-green-600 font-medium">(current)</span>
                        )}
                      </td>
                      {config.service === 'gemini' ? (
                        <>
                          <td className="px-4 py-2 text-right font-mono text-slate-900">
                            {config.inputPricePerMillion ? `$${config.inputPricePerMillion}` : '-'}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-slate-900">
                            {config.outputPricePerMillion ? `$${config.outputPricePerMillion}` : '-'}
                          </td>
                        </>
                      ) : (
                        <td className="px-4 py-2 text-right font-mono text-slate-900">
                          {config.pricePerSecond ? `$${config.pricePerSecond}` : '-'}
                        </td>
                      )}
                      <td className="px-4 py-2 text-slate-500 text-xs">
                        {config.notes || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
