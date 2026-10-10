/**
 * Setup Wizard Component
 * Guides users through initial configuration of the photography website
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL } from '../../config';
import RestartModal from '../RestartModal';
import CustomDropdown from '../AdminPortal/ConfigManager/components/CustomDropdown';
import './SetupWizard.css';
import type { SetupStatus } from './types';
import { error as logError, warn } from '../../utils/logger';

export default function SetupWizard() {
  const { t, i18n, ready } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [currentStep, setCurrentStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(i18n.language);
  
  // Form data
  const [siteName, setSiteName] = useState('');
  const [authorizedEmail, setAuthorizedEmail] = useState('');
  const [adminUsername, setAdminUsername] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [metaDescription, setMetaDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  
  // Account registration data
  const [authMethod, setAuthMethod] = useState<'google' | 'password'>('password');
  const [adminName, setAdminName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState('');
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [animationBoost, setAnimationBoost] = useState(false);
  
  // Trigger animation boost when step changes
  useEffect(() => {
    if (currentStep >= 2) {
      setAnimationBoost(true);
      const timer = setTimeout(() => {
        setAnimationBoost(false);
      }, 2000); // Boost for 2 seconds
      return () => clearTimeout(timer);
    }
  }, [currentStep]);
  
  // Handle restart modal close - redirect to appropriate auth flow
  const handleRestartComplete = () => {
    if (authMethod === 'google') {
      // For Google auth, redirect to Google OAuth flow
      window.location.href = `${API_URL}/api/auth/google`;
    } else {
      // For password auth, redirect to admin portal (will show login)
      window.location.href = '/admin';
    }
  };

  // Check setup status on mount
  useEffect(() => {
    checkSetupStatus();
  }, []);

  // Sync currentLanguage with i18n language changes and force re-render
  useEffect(() => {
    console.log(`[OOBE] i18n language changed to: ${i18n.language}, ready: ${ready}`);
    console.log(`[OOBE] Translation test after change: oobe.title = "${t('oobe.title')}"`);
    console.log(`[OOBE] Translation test after change: oobe.subtitle = "${t('oobe.subtitle')}"`);
    if (i18n.language !== currentLanguage) {
      setCurrentLanguage(i18n.language);
    }
  }, [i18n.language, ready, currentLanguage, t]);

  // Debug: Log when component mounts
  useEffect(() => {
    console.log(`[OOBE] Component mounted. i18n ready: ${ready}, language: ${i18n.language}`);
    console.log(`[OOBE] Sample translation test:`, t('oobe.title'));
  }, []);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type
      if (!file.type.startsWith('image/')) {
        setError('Please select an image file');
        return;
      }
      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        setError('Avatar image must be less than 5MB');
        return;
      }
      
      setAvatarFile(file);
      
      // Create preview
      const reader = new FileReader();
      reader.onloadend = () => {
        setAvatarPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
      setError(null);
    }
  };

  const checkSetupStatus = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/api/setup/status`);
      const data = await response.json();
      setSetupStatus(data);
      
      if (data.setupComplete) {
        // Setup is complete, redirect to home
        window.location.href = '/';
      }
    } catch (err) {
      setError('Failed to check setup status. Please try again.');
      logError('Setup status check failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    
    // Only allow form submission on step 3 (final step)
    if (currentStep !== 3) {
      return;
    }
    
    // Validation
    if (!siteName.trim()) {
      setError('Site name is required');
      return;
    }
    
    if (authMethod === 'google' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorizedEmail.trim())) {
      setError('Please enter a valid email address');
      return;
    }
    if (authMethod === 'password' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(adminUsername.trim())) {
      setError('Username must be 3–64 characters: letters, numbers, dots, underscores or hyphens');
      return;
    }

    // Validate based on auth method
    if (authMethod === 'password') {
      if (!adminName.trim()) {
        setError('Name is required');
        return;
      }
      if (adminPassword.length < 8) {
        setError('Password must be at least 8 characters');
        return;
      }
      if (adminPassword !== adminPasswordConfirm) {
        setError('Passwords do not match');
        return;
      }
    } else {
      if (!googleClientId.trim() || !googleClientSecret.trim()) {
        setError('Both Google Client ID and Secret are required');
        return;
      }
    }

    try {
      setSubmitting(true);

      // Upload the optional avatar before initialization; setup mutation routes
      // are locked once the backend reports setup complete.
      if (avatarFile) {
        try {
          const formData = new FormData();
          formData.append('avatar', avatarFile);

          const avatarResponse = await fetch(`${API_URL}/api/setup/upload-avatar`, {
            method: 'POST',
            body: formData,
          });

          if (!avatarResponse.ok) {
            warn('Avatar upload failed, but continuing with setup');
          }
        } catch (err) {
          warn('Avatar upload failed:', err);
          // Don't fail the entire setup if avatar upload fails
        }
      }
      
      // Initialize the configuration with user account data
      const response = await fetch(`${API_URL}/api/setup/initialize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          siteName,
          authorizedEmail: authMethod === 'google' ? authorizedEmail.trim() : undefined,
          adminUsername: authMethod === 'password' ? adminUsername.trim() : undefined,
          authMethod,
          adminName: authMethod === 'password' ? adminName : undefined,
          adminPassword: authMethod === 'password' ? adminPassword : undefined,
          googleClientId: authMethod === 'google' ? googleClientId : undefined,
          googleClientSecret: authMethod === 'google' ? googleClientSecret : undefined,
          metaDescription: metaDescription || t('oobe.siteDescriptionPlaceholder', { siteName }),
          language: currentLanguage,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Setup failed');
      }

      setSuccess(t('oobe.completeHeading'));
      setCurrentStep(4);

      // Only show restart modal for Google OAuth (needs server restart)
      // Password auth works immediately without restart
      if (data.requiresRestart) {
        setShowRestartModal(true);
      } else {
        // For password auth, redirect directly to admin portal
        setTimeout(() => {
          window.location.href = '/admin';
        }, 2000); // Give user time to see success message
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed. Please try again.');
      logError('Setup initialization failed:', err);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !ready) {
    return (
      <div className="setup-wizard">
        <div className="setup-container">
          <div className="setup-loading">
            <div className="loading-spinner"></div>
            <p>{ready ? t('common.checkingSetupStatus') : t('common.loading')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!setupStatus) {
    return (
      <div className="setup-wizard">
        <div className="setup-container">
          <div className="setup-error">
            <h2>⚠️ {t('oobe.setupError')}</h2>
            <p>{error || 'Failed to load setup status'}</p>
            <button onClick={checkSetupStatus} className="retry-button">
              {t('oobe.tryAgain')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const languages = [
    { value: 'en', label: 'English', emoji: '🇺🇸' },
    { value: 'es', label: 'Español', emoji: '🇪🇸' },
    { value: 'fr', label: 'Français', emoji: '🇫🇷' },
    { value: 'de', label: 'Deutsch', emoji: '🇩🇪' },
    { value: 'ja', label: '日本語', emoji: '🇯🇵' },
    { value: 'zh', label: '中文', emoji: '🇨🇳' },
    { value: 'ko', label: '한국어', emoji: '🇰🇷' },
    { value: 'it', label: 'Italiano', emoji: '🇮🇹' },
    { value: 'pt', label: 'Português', emoji: '🇵🇹' },
    { value: 'ru', label: 'Русский', emoji: '🇷🇺' },
    { value: 'nl', label: 'Nederlands', emoji: '🇳🇱' },
    { value: 'pl', label: 'Polski', emoji: '🇵🇱' },
    { value: 'tr', label: 'Türkçe', emoji: '🇹🇷' },
    { value: 'sv', label: 'Svenska', emoji: '🇸🇪' },
    { value: 'no', label: 'Norsk', emoji: '🇳🇴' },
    { value: 'ro', label: 'Română', emoji: '🇷🇴' },
    { value: 'tl', label: 'Filipino', emoji: '🇵🇭' },
    { value: 'vi', label: 'Tiếng Việt', emoji: '🇻🇳' },
    { value: 'id', label: 'Bahasa Indonesia', emoji: '🇮🇩' },
  ];

  const handleLanguageChange = (languageCode: string) => {
    console.log(`[OOBE] Changing language to: ${languageCode}`);
    // Change the language - this will trigger i18n to load translations
    // The useEffect will sync currentLanguage state, and useTranslation will trigger re-render
    i18n.changeLanguage(languageCode).then(() => {
      console.log(`[OOBE] Language changed successfully to: ${languageCode}`);
    }).catch((error) => {
      console.error(`[OOBE] Failed to change language:`, error);
    });
  };

  return (
    <div className={`setup-wizard ${animationBoost ? 'animation-boost' : ''}`}>
      <div className="setup-container">
        <div className="setup-header">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <img src="/icon-192.png" alt="Galleria" style={{ width: '48px', height: '48px' }} />
            <h1 style={{ margin: 0 }}>{t('oobe.title')}</h1>
          </div>
          <p>{t('oobe.subtitle')}</p>
          
          {/* Language Selector */}
          <div style={{ 
            marginTop: '1rem',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.75rem',
            position: 'relative',
            zIndex: 1000
          }}>
            <label style={{ 
              color: '#9ca3af',
              fontSize: '0.875rem',
              whiteSpace: 'nowrap'
            }}>
              🌐 {t('oobe.language')}:
            </label>
            <div style={{ width: '200px' }}>
              <CustomDropdown
                value={currentLanguage}
                options={languages}
                onChange={handleLanguageChange}
                placeholder={t('oobe.selectLanguage')}
              />
            </div>
          </div>
        </div>

        <div className="setup-progress">
          <div className={`progress-step ${currentStep >= 1 ? 'active' : ''} ${currentStep > 1 ? 'complete' : ''}`}>
            <div className="step-number">1</div>
            <div className="step-label">{t('oobe.step1Title')}</div>
          </div>
          <div className="progress-line"></div>
          <div className={`progress-step ${currentStep >= 2 ? 'active' : ''} ${currentStep > 2 ? 'complete' : ''}`}>
            <div className="step-number">2</div>
            <div className="step-label">{t('oobe.step2Title')}</div>
          </div>
          <div className="progress-line"></div>
          <div className={`progress-step ${currentStep >= 3 ? 'active' : ''} ${currentStep > 3 ? 'complete' : ''}`}>
            <div className="step-number">3</div>
            <div className="step-label">{t('oobe.step3Title')}</div>
          </div>
          <div className="progress-line"></div>
          <div className={`progress-step ${currentStep >= 4 ? 'active' : ''}`}>
            <div className="step-number">4</div>
            <div className="step-label">{t('oobe.step4Title')}</div>
          </div>
        </div>

        {error && (
          <div className="setup-message error">
            <span className="message-icon">❌</span>
            {error}
          </div>
        )}

        {success && (
          <div className="setup-message success">
            <span className="message-icon">✅</span>
            {success}
          </div>
        )}

        <form onSubmit={handleSubmit} className="setup-form">
          {currentStep === 1 && (
            <div className="setup-step">
              <h2>{t('oobe.basicInfoHeading')}</h2>
              <p className="step-description">
                {t('oobe.basicInfoDescription')}
              </p>

              <div className="form-group">
                <label htmlFor="siteName">
                  {t('oobe.siteNameLabel')} *
                  <span className="field-hint">{t('oobe.siteNameHint')}</span>
                </label>
                <input
                  type="text"
                  id="siteName"
                  value={siteName}
                  onChange={(e) => setSiteName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && siteName.trim()) {
                      e.preventDefault();
                      setCurrentStep(2);
                    }
                  }}
                  placeholder={t('oobe.siteNamePlaceholder')}
                  required
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label htmlFor="metaDescription">
                  {t('oobe.siteDescriptionLabel')}
                  <span className="field-hint">{t('oobe.siteDescriptionHint')}</span>
                </label>
                <textarea
                  id="metaDescription"
                  value={metaDescription}
                  onChange={(e) => setMetaDescription(e.target.value)}
                  placeholder={siteName ? t('oobe.siteDescriptionPlaceholder', { siteName }) : t('oobe.siteDescriptionDefaultPlaceholder')}
                  rows={3}
                />
              </div>

              <div className="form-actions">
                <button 
                  type="button" 
                  onClick={() => setCurrentStep(2)}
                  className="button button-primary"
                  disabled={!siteName.trim()}
                >
                  {t('oobe.nextCreateAccount')}
                </button>
              </div>
            </div>
          )}

          {currentStep === 2 && (
            <div className="setup-step">
              <h2>{t('oobe.accountHeading')}</h2>
              <p className="step-description">
                {t('oobe.accountDescription')}
              </p>

              <div className="form-group">
                <label htmlFor="loginIdentifier">
                  {authMethod === 'google' ? t('oobe.emailLabel') : t('oobe.usernameLabel', 'Username')} *
                  <span className="field-hint">{authMethod === 'google' ? t('oobe.emailHint') : t('oobe.usernameHint', 'Choose a local username. No email address is needed.')}</span>
                </label>
                <input
                  type={authMethod === 'google' ? 'email' : 'text'}
                  id="loginIdentifier"
                  name={authMethod === 'google' ? 'email' : 'username'}
                  autoComplete="username"
                  value={authMethod === 'google' ? authorizedEmail : adminUsername}
                  onChange={(e) => authMethod === 'google' ? setAuthorizedEmail(e.target.value) : setAdminUsername(e.target.value)}
                  placeholder={authMethod === 'google' ? 'john@example.com' : 'photographer'}
                  maxLength={authMethod === 'google' ? 254 : 64}
                  required
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label>
                  {t('oobe.authMethodLabel')} *
                  <span className="field-hint">{t('oobe.authMethodHint')}</span>
                </label>
                <div className="auth-method-choice">
                  <label className="auth-method-option">
                    <input
                      type="radio"
                      name="authMethod"
                      value="password"
                      checked={authMethod === 'password'}
                      onChange={(e) => setAuthMethod(e.target.value as 'password' | 'google')}
                    />
                    <div className="auth-method-label">
                      <strong>🔑 {t('oobe.authMethodPassword')}</strong>
                      <span>{t('oobe.authMethodUsernameDescription', 'Sign in with a username and password')}</span>
                    </div>
                  </label>
                  <label className="auth-method-option">
                    <input
                      type="radio"
                      name="authMethod"
                      value="google"
                      checked={authMethod === 'google'}
                      onChange={(e) => setAuthMethod(e.target.value as 'password' | 'google')}
                    />
                    <div className="auth-method-label">
                      <strong>🔐 {t('oobe.authMethodGoogle')}</strong>
                      <span>{t('oobe.authMethodGoogleDescription')}</span>
                    </div>
                  </label>
                </div>
              </div>

              {authMethod === 'password' && (
                <>
                  <div className="form-group">
                    <label htmlFor="adminName">
                      {t('oobe.fullNameLabel')} *
                      <span className="field-hint">{t('oobe.fullNameHint')}</span>
                    </label>
                    <input
                      type="text"
                      id="adminName"
                      value={adminName}
                      onChange={(e) => setAdminName(e.target.value)}
                      placeholder="John Doe"
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="adminPassword">
                      {t('oobe.passwordLabel')} *
                      <span className="field-hint">{t('oobe.passwordHint')}</span>
                    </label>
                    <input
                      type="password"
                      id="adminPassword"
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      placeholder="••••••••"
                      minLength={8}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="adminPasswordConfirm">
                      {t('oobe.confirmPasswordLabel')} *
                    </label>
                    <input
                      type="password"
                      id="adminPasswordConfirm"
                      value={adminPasswordConfirm}
                      onChange={(e) => setAdminPasswordConfirm(e.target.value)}
                      placeholder="••••••••"
                      minLength={8}
                      required
                    />
                  </div>
                </>
              )}

              {authMethod === 'google' && (
                <>
                  <div className="info-box">
                    <p>
                      <strong>{t('oobe.googleInstructions')}</strong>
                    </p>
                    <ol>
                      <li>{t('oobe.googleStep1')} <a href="https://console.cloud.google.com" target="_blank" rel="noopener noreferrer">{t('oobe.googleCloudConsole')}</a></li>
                      <li>{t('oobe.googleStep2')}</li>
                      <li>{t('oobe.googleStep3')}</li>
                      <li>{t('oobe.googleStep4')}</li>
                      <li>{t('oobe.googleStep5')} <code>{(API_URL || window.location.origin)}/api/auth/google/callback</code></li>
                      <li>{t('oobe.googleStep6')}</li>
                    </ol>
                  </div>

                  <div className="form-group">
                    <label htmlFor="googleClientId">
                      {t('oobe.googleClientIdLabel')} *
                    </label>
                    <input
                      type="text"
                      id="googleClientId"
                      value={googleClientId}
                      onChange={(e) => setGoogleClientId(e.target.value)}
                      placeholder="xxxxx.apps.googleusercontent.com"
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="googleClientSecret">
                      {t('oobe.googleClientSecretLabel')} *
                    </label>
                    <input
                      type="password"
                      id="googleClientSecret"
                      value={googleClientSecret}
                      onChange={(e) => setGoogleClientSecret(e.target.value)}
                      placeholder="GOCSPX-xxxxx"
                      required
                    />
                  </div>
                </>
              )}

              <div className="form-actions">
                <button 
                  type="button" 
                  onClick={() => setCurrentStep(1)}
                  className="button button-secondary"
                >
                  {t('oobe.backToBasicInfo')}
                </button>
                <button 
                  type="button" 
                  onClick={() => {
                    // Validation
                    if (authMethod === 'google' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorizedEmail.trim())) {
                      setError(t('oobe.errorInvalidEmail'));
                      return;
                    }
                    if (authMethod === 'password' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(adminUsername.trim())) {
                      setError(t('oobe.errorInvalidUsername', 'Username must be 3–64 characters: letters, numbers, dots, underscores or hyphens'));
                      return;
                    }

                    if (authMethod === 'password') {
                      if (!adminName.trim()) {
                        setError(t('oobe.errorRequiredField'));
                        return;
                      }
                      if (adminPassword.length < 8) {
                        setError(t('oobe.errorPasswordTooShort'));
                        return;
                      }
                      if (adminPassword !== adminPasswordConfirm) {
                        setError(t('oobe.errorPasswordMismatch'));
                        return;
                      }
                    } else {
                      if (!googleClientId.trim() || !googleClientSecret.trim()) {
                        setError(t('oobe.errorRequiredField'));
                        return;
                      }
                    }
                    
                    setError(null);
                    setCurrentStep(3);
                  }}
                  className="button button-primary"
                >
                  {t('oobe.nextCustomize')}
                </button>
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div className="setup-step">
              <h2>{t('oobe.customizeHeading')}</h2>
              <p className="step-description">
                {t('oobe.customizeDescription')}
              </p>

              <div className="form-group">
                <label htmlFor="avatar">
                  {t('oobe.avatarOptional')}
                  <span className="field-hint">{t('oobe.avatarHint')}</span>
                </label>
                <div className="avatar-upload">
                  {avatarPreview && (
                    <div className="avatar-preview">
                      <img src={avatarPreview} alt="Avatar preview" />
                    </div>
                  )}
                  <input
                    type="file"
                    id="avatar"
                    accept="image/*"
                    onChange={handleAvatarChange}
                    className="file-input"
                  />
                  <label htmlFor="avatar" className="file-label">
                    {avatarFile ? t('oobe.imageSelected') : t('oobe.chooseImage')}
                  </label>
                  {avatarFile && (
                    <button
                      type="button"
                      onClick={() => {
                        setAvatarFile(null);
                        setAvatarPreview(null);
                      }}
                      className="button-text"
                    >
                      {t('oobe.remove')}
                    </button>
                  )}
                </div>
              </div>

              <div className="form-actions">
                <button 
                  type="button" 
                  onClick={() => setCurrentStep(2)}
                  className="button button-secondary"
                >
                  {t('oobe.backToAccount')}
                </button>
                <button 
                  type="submit"
                  className="button button-primary"
                  disabled={submitting}
                >
                  {submitting ? t('oobe.settingUp') : t('oobe.completeSetup')}
                </button>
              </div>
            </div>
          )}

          {currentStep === 4 && (
            <div className="setup-step setup-complete">
              <div className="complete-icon">✓</div>
              <h2>{t('oobe.completeHeading')}</h2>
              <p>{t('oobe.completeDescription')}</p>
              <p className="complete-subtext">{t('oobe.completeSubtext')}</p>
              
              <div className="next-steps">
                <h3>{t('oobe.whatWeSetUp')}</h3>
                <ul>
                  <li>✅ {t('oobe.siteConfigSaved')}</li>
                  <li>✅ {t('oobe.adminAccountCreated')}</li>
                  <li>✅ {t('oobe.databaseInitialized')}</li>
                  <li>✅ {t('oobe.directoriesCreated')}</li>
                  <li>✅ {t('oobe.authenticationConfigured')}</li>
                  <li>🔐 {t('oobe.redirectToSignIn')}</li>
                  <li>📸 {t('oobe.uploadFirstAlbum')}</li>
                </ul>
              </div>
            </div>
          )}
        </form>

        <div className="setup-footer">
          <p>
            Need help? Check the{' '}
            <a
              href={`https://galleria.website/${i18n.language}/docs/`}
              target="_blank"
              rel="noopener noreferrer"
            >
              documentation
            </a>
          </p>
        </div>
      </div>
      
      {/* Restart Modal */}
      {showRestartModal && (
        <RestartModal
          onClose={handleRestartComplete}
          message={t('oobe.setupCompleteWaitingRestart')}
        />
      )}
    </div>
  );
}
