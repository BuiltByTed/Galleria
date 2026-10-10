/**
 * Metrics Component
 * Displays analytics data and visualizations from OpenObserve
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL } from '../../../config';
import { fetchWithRateLimitCheck } from '../../../utils/fetchWrapper';
import { formatNumber } from '../../../utils/formatters';
import { formatDateFromMicroseconds, formatDurationDetailed, formatLocalDate } from '../../../utils/metricsHelpers';
import CustomDropdown from '../ConfigManager/components/CustomDropdown';
import VisitorMap from './VisitorMap';
import VisitorsChart from './VisitorsChart';
import PageviewsChart from './PageviewsChart';
import PicturesTable from './PicturesTable';
import PagesTable from './PagesTable';
import ReferrersTable from './ReferrersTable';
import EventTypesTable from './EventTypesTable';
import './SkeletonLoader.css';
import './Metrics.css';

// Import interfaces from types.ts (canonical location)
import type { Stats, TimeSeriesData, HourlyPageviewData, VisitorLocation } from './types';
import { error as logError } from '../../../utils/logger';

export default function Metrics() {
  const { t } = useTranslation();
  // Get the secondary color from CSS custom property
  const secondaryColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--secondary-color')
    .trim() || '#3b82f6';

  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState(30); // days
  const [visitorsOverTime, setVisitorsOverTime] = useState<TimeSeriesData[]>([]);
  const [loadingTimeSeries, setLoadingTimeSeries] = useState(false);
  const [pageviewsByHour, setPageviewsByHour] = useState<HourlyPageviewData[]>([]);
  const [loadingPageviewsByHour, setLoadingPageviewsByHour] = useState(false);
  const [visitorLocations, setVisitorLocations] = useState<VisitorLocation[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Record<string, Set<number>>>({});
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRateLimitCheck(`${API_URL}/api/metrics/stats?days=${timeRange}`);

      if (!res.ok) {
        throw new Error(t('metrics.failedToLoad'));
      }

      const data = await res.json();
      setStats(data);
    } catch (err) {
      logError('Failed to load metrics:', err);
      setError(err instanceof Error ? err.message : t('metrics.failedToLoad'));
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  const loadVisitorsOverTime = useCallback(async () => {
    setLoadingTimeSeries(true);
    try {
      // Get browser timezone offset in hours (negative of getTimezoneOffset() / 60)
      const offsetMinutes = new Date().getTimezoneOffset();
      const offsetHours = -offsetMinutes / 60; // Negative because getTimezoneOffset returns opposite sign
      
      const res = await fetchWithRateLimitCheck(`${API_URL}/api/metrics/visitors-over-time?days=${timeRange}&timezoneOffset=${offsetHours}`);

      if (!res.ok) {
        throw new Error(t('metrics.failedToLoadTimeSeries'));
      }

      const data = await res.json();
      const actualData = data.hits || [];
      
      // Fill in missing dates with 0 visitors
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const filledData: TimeSeriesData[] = [];
      
      for (let i = timeRange - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = formatLocalDate(date);
        
        // Find if we have data for this date (normalize API date to YYYY-MM-DD format)
        const existing = actualData.find((d: any) => {
          const apiDateStr = d.date?.toString().split('T')[0];
          return apiDateStr === dateStr;
        });
        
        filledData.push({
          date: dateStr,
          count: existing ? existing.count : 0
        });
      }
      
      setVisitorsOverTime(filledData);
    } catch (err) {
      logError('Failed to load time series:', err);
    } finally {
      setLoadingTimeSeries(false);
    }
  }, [timeRange]);

  const loadPageviewsByHour = useCallback(async () => {
    setLoadingPageviewsByHour(true);
    try {
      // Get browser timezone offset
      const offsetMinutes = new Date().getTimezoneOffset();
      const offsetHours = -offsetMinutes / 60;
      
      const res = await fetchWithRateLimitCheck(`${API_URL}/api/metrics/pageviews-by-hour?days=${timeRange}&timezoneOffset=${offsetHours}`);

      if (!res.ok) {
        throw new Error(t('metrics.failedToLoadHourlyPageviews'));
      }

      const data = await res.json();
      const hits = data.hits || [];
      
      // Fill in missing hours with 0 pageviews
      const now = new Date();
      const filledData: HourlyPageviewData[] = [];
      
      // Calculate the start time (timeRange days ago)
      const startTime = new Date(now);
      startTime.setDate(startTime.getDate() - timeRange);
      startTime.setMinutes(0, 0, 0); // Round to the hour
      
      // Generate all hours in the time range
      const currentHour = new Date(startTime);
      while (currentHour <= now) {
        // Find if we have data for this hour
        const existing = hits.find((d: any) => {
          if (!d.hour_local) return false;
          const apiHour = new Date(d.hour_local);
          return apiHour.getTime() === currentHour.getTime();
        });
        
        filledData.push({
          hour: currentHour.toISOString(),
          pageviews: existing ? existing.pageviews : 0
        });
        
        // Move to next hour
        currentHour.setHours(currentHour.getHours() + 1);
      }
      
      setPageviewsByHour(filledData);
    } catch (err) {
      logError('Failed to load hourly pageviews:', err);
    } finally {
      setLoadingPageviewsByHour(false);
    }
  }, [timeRange]);

  const loadVisitorLocations = useCallback(async () => {
    setLoadingLocations(true);
    try {
      const res = await fetchWithRateLimitCheck(`${API_URL}/api/metrics/visitor-locations?days=${timeRange}`);

      if (!res.ok) {
        throw new Error(t('metrics.failedToLoadLocations'));
      }

      const data = await res.json();
      setVisitorLocations(data.locations || []);
    } catch (err) {
      logError('Failed to load visitor locations:', err);
    } finally {
      setLoadingLocations(false);
    }
  }, [timeRange]);

  useEffect(() => {
    loadStats();
    loadVisitorsOverTime();
    loadPageviewsByHour();
    loadVisitorLocations();
  }, [loadStats, loadVisitorsOverTime, loadPageviewsByHour, loadVisitorLocations]);

  const toggleRowExpansion = (tableName: string, rowIndex: number) => {
    setExpandedRows(prev => {
      const newExpanded = { ...prev };
      if (!newExpanded[tableName]) {
        newExpanded[tableName] = new Set();
      }
      const tableExpanded = new Set(newExpanded[tableName]);
      const isExpanding = !tableExpanded.has(rowIndex);
      
      if (tableExpanded.has(rowIndex)) {
        tableExpanded.delete(rowIndex);
      } else {
        tableExpanded.add(rowIndex);
      }
      newExpanded[tableName] = tableExpanded;
      
      // Scroll expanded row into view
      if (isExpanding) {
        setTimeout(() => {
          // Find the specific table by data attribute and get its rows
          const table = document.querySelector(`.metrics-table[data-table-name="${tableName}"]`);
          if (table) {
            const rows = table.querySelectorAll('tbody tr.clickable-row');
            const targetRow = rows[rowIndex];
            if (targetRow) {
              const nextRow = targetRow.nextElementSibling;
              if (nextRow && nextRow.classList.contains('expanded-content-row')) {
                nextRow.scrollIntoView({ 
                  behavior: 'smooth', 
                  block: 'nearest',
                  inline: 'nearest'
                });
              }
            }
          }
        }, 50);
      }
      
      return newExpanded;
    });
  };

  const toggleTableExpansion = (tableName: string) => {
    setExpandedTables(prev => ({
      ...prev,
      [tableName]: !prev[tableName]
    }));
  };

  if (error && !stats) {
    return (
      <div className="metrics-container">
        <div className="error-message">
          <p>{error}</p>
          <button onClick={loadStats} className="btn-primary">
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="admin-section">
      <div className="metrics-header-wrapper">
        <div className="metrics-header-content">
          <h2>{t('metrics.title')}</h2>
          <p className="section-description">{t('metrics.description')}</p>
        </div>
        <div className="metrics-time-range">
          <label style={{ marginRight: '0.5rem' }}>{t('metrics.timeRange')}:</label>
          <CustomDropdown
            value={String(timeRange)}
            options={[
              { value: '7', label: t('metrics.last7Days'), emoji: '📅' },
              { value: '30', label: t('metrics.last30Days'), emoji: '📆' },
              { value: '90', label: t('metrics.last90Days'), emoji: '🗓️' },
              { value: '365', label: t('metrics.lastYear'), emoji: '📊' },
            ]}
            onChange={(value) => setTimeRange(Number(value))}
            style={{ minWidth: '200px' }}
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="metrics-summary">
        <div className="metric-card">
          <div className="metric-icon">👥</div>
          <div className="metric-content">
            {loading && !stats ? (
              <div className="skeleton-value"></div>
            ) : (
              <div className="metric-value">{formatNumber(stats?.uniqueVisitors || 0)}</div>
            )}
            <div className="metric-label">{t('metrics.uniqueVisitors')}</div>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-icon">📄</div>
          <div className="metric-content">
            {loading && !stats ? (
              <div className="skeleton-value"></div>
            ) : (
              <div className="metric-value">{formatNumber(stats?.pageViews || 0)}</div>
            )}
            <div className="metric-label">{t('metrics.pageViews')}</div>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-icon">⏱️</div>
          <div className="metric-content">
            {loading && !stats ? (
              <div className="skeleton-value"></div>
            ) : (
              <div className="metric-value">{formatDurationDetailed(stats?.totalViewDuration || 0)}</div>
            )}
            <div className="metric-label">{t('metrics.totalTimeViewing')}</div>
          </div>
        </div>
      </div>

      {/* Visitor Locations Map */}
      <div className="metrics-section">
        <h3>{t('metrics.visitorLocations')}</h3>
        <p style={{ color: '#9ca3af', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          {t('metrics.visitorLocationsDescription')}
        </p>
        <VisitorMap locations={visitorLocations} loading={loadingLocations} />
      </div>

      {/* Charts Grid - Side by Side on Desktop */}
      <div className="metrics-grid">
        <div className="metrics-section">
          <h3>{t('metrics.uniqueVisitorsOverTime')}</h3>
          <p style={{ color: '#9ca3af', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
            {t('metrics.uniqueVisitorsOverTimeDescription')}
          </p>
          <VisitorsChart 
            data={visitorsOverTime} 
            loading={loadingTimeSeries} 
            secondaryColor={secondaryColor} 
          />
        </div>

        <div className="metrics-section">
          <h3>{t('metrics.pageviewsPerHour')}</h3>
          <p style={{ color: '#9ca3af', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
            {t('metrics.pageviewsPerHourDescription')}
          </p>
          <PageviewsChart 
            data={pageviewsByHour} 
            loading={loadingPageviewsByHour} 
            secondaryColor={secondaryColor} 
          />
        </div>
      </div>

      {/* Tables Grid - Most Engaging Pictures and Top Pages */}
      <div className="metrics-grid">
        <div className="metrics-section">
          <h3>{t('metrics.mostEngagingPictures')}</h3>
          <p style={{ color: '#9ca3af', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
            {t('metrics.mostEngagingPicturesDescription')}
          </p>
          <PicturesTable
            pictures={stats?.topPicturesByDuration || []}
            expandedRows={expandedRows['pictures'] || new Set()}
            isExpanded={expandedTables['pictures'] || false}
            loading={loading && !stats}
            onToggleRow={(index) => toggleRowExpansion('pictures', index)}
            onToggleTable={() => toggleTableExpansion('pictures')}
          />
        </div>

        <div className="metrics-section">
          <h3>{t('metrics.topPages')}</h3>
          <p style={{ color: '#9ca3af', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
            {t('metrics.topPagesDescription')}
          </p>
          <PagesTable
            pages={stats?.topPages || []}
            totalPageViews={stats?.pageViews || 0}
            expandedRows={expandedRows['pages'] || new Set()}
            isExpanded={expandedTables['pages'] || false}
            loading={loading && !stats}
            onToggleRow={(index) => toggleRowExpansion('pages', index)}
            onToggleTable={() => toggleTableExpansion('pages')}
          />
        </div>
      </div>

      {/* Tables Grid - Top Referrers and Event Types */}
      <div className="metrics-grid">
        <div className="metrics-section">
          <h3>{t('metrics.topReferrers')}</h3>
          <ReferrersTable
            referrers={stats?.topReferrers || []}
            expandedRows={expandedRows['referrers'] || new Set()}
            isExpanded={expandedTables['referrers'] || false}
            loading={loading && !stats}
            onToggleRow={(index) => toggleRowExpansion('referrers', index)}
            onToggleTable={() => toggleTableExpansion('referrers')}
          />
        </div>

        <div className="metrics-section">
          <h3>{t('metrics.eventTypes')}</h3>
          <EventTypesTable
            events={stats?.eventTypes || []}
            expandedRows={expandedRows['events'] || new Set()}
            isExpanded={expandedTables['events'] || false}
            loading={loading && !stats}
            onToggleRow={(index) => toggleRowExpansion('events', index)}
            onToggleTable={() => toggleTableExpansion('events')}
          />
        </div>
      </div>

      {/* Footer Info */}
      {stats && (
        <div className="metrics-footer">
          <p>
            {t('metrics.dataFrom', { start: formatDateFromMicroseconds(stats.timeRange.start), end: formatDateFromMicroseconds(stats.timeRange.end) })}
          </p>
        </div>
      )}
    </section>
  );
}
