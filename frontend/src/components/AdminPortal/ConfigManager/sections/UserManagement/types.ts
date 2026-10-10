export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  mfa_enabled: boolean;
  passkey_count: number;
  auth_methods: string[];
  status?: string;
  picture?: string;
  /** Present only on create-invite response, never on list payload */
  invite_token?: string | null;
}

export interface Passkey {
  id: string;
  name: string;
  created_at: string;
}

export interface MFASetupData {
  userId: number;
  qrCode: string;
  secret: string;
  backupCodes: string[];
  setupToken: string;
}

export interface NewUserState {
  email: string;
  role: string;
  inviteToken?: string;
}

export interface PasswordChangeState {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface MessageType {
  type: "success" | "error";
  text: string;
}

