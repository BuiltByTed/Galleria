/**
 * Frontend Settings Component
 */

import React, { useState } from 'react';
import { API_URL } from '../../../../config';
import { ConfigData } from '../types';


interface FrontendSettingsProps {
  config: ConfigData;
  updateConfig: (path: string[], value: any) => void;
  hasUnsavedChanges: boolean;
  onSave: () => void;
  onCancel: () => void;
  savingSection: string | null;
  showConfirmation: (message: string) => Promise<boolean>;
  setMessage: (message: { type: "success" | "error"; text: string }) => void;
}

const FrontendSettings: React.FC<FrontendSettingsProps> = ({
  config,
  updateConfig,
  hasUnsavedChanges,
  onSave,
  onCancel,
  savingSection,
  showConfirmation,
  setMessage,
}) => {
  const [restartingFrontend, setRestartingFrontend] = useState(false);

  const handleRestartFrontend = async () => {
    const confirmed = await showConfirmation(
      "⚠️ Restart the frontend server? This requires manual restart if in development mode."
    );
    if (!confirmed) return;

    setRestartingFrontend(true);

    try {
      const res = await fetch(`${API_URL}/api/system/restart/frontend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        setMessage({ type: "success", text: data.message });
      } else {
        const errorData = await res
          .json()
          .catch(() => ({ error: "Unknown error" }));
        setMessage({
          type: "error",
          text: errorData.error || "Failed to restart frontend",
        });
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Network error occurred";
      setMessage({ type: "error", text: errorMessage });
    } finally {
      setRestartingFrontend(false);
    }
  };

  return (
    <div className="settings-section" style={{ marginBottom: "2rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.75rem",
        }}
      >
        <label className="settings-section-label">FRONTEND</label>
        {hasUnsavedChanges && (
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              disabled={savingSection !== null}
              className="btn-secondary"
              style={{
                padding: "0.4rem 0.8rem",
                fontSize: "0.85rem",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSave();
              }}
              disabled={savingSection !== null}
              className="btn-primary"
              style={{ padding: "0.4rem 0.8rem", fontSize: "0.85rem" }}
            >
              {savingSection === "Frontend" ? "Saving..." : "Save"}
            </button>
          </div>
        )}
      </div>
      <p
        style={{
          fontSize: "0.85rem",
          color: "#888",
          marginTop: "0",
          marginBottom: "1rem",
        }}
      >
        Frontend development server port and API URL for connecting to
        the backend
      </p>
      <div className="config-grid-inner">
        <div className="branding-group">
          <label className="branding-label">Port</label>
          <input
            type="number"
            value={config.environment.frontend.port}
            onChange={(e) =>
              updateConfig(
                ["environment", "frontend", "port"],
                parseInt(e.target.value)
              )
            }
            className="branding-input"
          />
        </div>

        <div className="branding-group">
          <label className="branding-label">API URL (optional)</label>
          <input
            type="text"
            value={config.environment.frontend.apiUrl}
            placeholder="Leave blank to use the site URL"
            onChange={(e) =>
              updateConfig(
                ["environment", "frontend", "apiUrl"],
                e.target.value
              )
            }
            className="branding-input"
          />
        </div>
      </div>

      {/* Frontend Restart Button */}
      <div
        style={{
          marginTop: "1rem",
          paddingTop: "1rem",
          borderTop: "1px solid rgba(255, 255, 255, 0.05)",
        }}
      >
        <button
          type="button"
          onClick={handleRestartFrontend}
          disabled={restartingFrontend}
          className="btn-secondary"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          🔄{" "}
          {restartingFrontend
            ? "Restarting..."
            : "Restart Frontend Server"}
        </button>
        <p
          style={{
            fontSize: "0.85rem",
            color: "#888",
            marginTop: "0.5rem",
            marginBottom: 0,
          }}
        >
          In development, manually restart your dev server. In
          production, use your process manager.
        </p>
      </div>
    </div>
  );
};

export default FrontendSettings;

