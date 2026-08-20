"use client";

import { useState, useEffect, useRef } from "react";
import { AlertCircle, CheckCircle, Mail, Lock, User } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

interface AccountSettingsProps {
  onClose?: () => void;
  onShowToast?: (message: string, type: "success" | "error" | "info") => void;
}

export function AccountSettings({
  onClose,
  onShowToast,
}: AccountSettingsProps) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [loading, setLoading] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load user profile on mount
  useEffect(() => {
    if (user) {
      setName(user.name || "");
      setEmail(user.email || "");
      setLoadingProfile(false);
    }
  }, [user]);

  const validateEmail = (emailValue: string): string | null => {
    if (!emailValue) return "Email address is required";
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailValue)) {
      return "Please enter a valid email address";
    }
    return null;
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string | undefined> = {};

    const emailError = validateEmail(email);
    if (emailError) newErrors.email = emailError;

    if (Object.keys(newErrors).length > 0) {
      setFieldErrors(newErrors);
      onShowToast?.("Please correct the errors below", "error");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email }),
      });

      const data = await response.json();

      if (!response.ok) {
        onShowToast?.(data.error || "Failed to update profile", "error");
        return;
      }

      onShowToast?.("Profile updated successfully", "success");
    } catch (error) {
      onShowToast?.("An error occurred while updating profile", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string | undefined> = {};

    if (!currentPassword)
      newErrors.currentPassword = "Current password is required";
    if (!newPassword) newErrors.newPassword = "New password is required";
    if (newPassword.length < 8)
      newErrors.newPassword = "Password must be at least 8 characters";
    if (newPassword !== confirmPassword)
      newErrors.confirmPassword = "Passwords do not match";

    if (Object.keys(newErrors).length > 0) {
      setFieldErrors(newErrors);
      onShowToast?.("Please correct the errors below", "error");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/user/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        onShowToast?.(data.error || "Failed to change password", "error");
        return;
      }

      onShowToast?.("Password changed successfully", "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      onShowToast?.("An error occurred while changing password", "error");
    } finally {
      setLoading(false);
    }
  };

  const clearFieldError = (field: string) => {
    setFieldErrors({ ...fieldErrors, [field]: undefined });
  };

  if (loadingProfile) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent"></div>
      </div>
    );
  }

  // OIDC users cannot change their profile
  if (user?.authType === "oidc") {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-8">
          <h2 className="text-2xl sm:text-3xl font-bold">Account Settings</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Manage your account information and security settings
        </p>

        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">
            <strong>Note:</strong> Your account is connected to{" "}
            {user?.oidcProvider || "an OIDC provider"}. To change your profile
            information, email, or password, please update them through your
            OIDC provider&apos;s account settings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <h2 className="text-2xl sm:text-3xl font-bold">Account Settings</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Manage your account information and security settings
      </p>

      {/* Profile Information Card */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-xl font-semibold mb-6">Profile Information</h3>

        <form onSubmit={handleSaveProfile} className="space-y-4">
          {/* Name Field */}
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium mb-2 flex items-center gap-2"
            >
              <User className="w-4 h-4" />
              Display Name
            </label>
            <div>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearFieldError("name");
                }}
                className={`w-full px-3 py-2 bg-background border rounded focus:outline-none focus:ring-2 transition-all ${
                  fieldErrors.name
                    ? "border-red-500 focus:ring-red-500/50"
                    : "border-border focus:ring-primary"
                }`}
                placeholder="Your display name"
              />
              {fieldErrors.name && (
                <p className="text-red-500 text-xs mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {fieldErrors.name}
                </p>
              )}
            </div>
          </div>

          {/* Email Field */}
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium mb-2 flex items-center gap-2"
            >
              <Mail className="w-4 h-4" />
              Email Address
            </label>
            <div>
              <input
                id="email"
                type="text"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearFieldError("email");
                }}
                className={`w-full px-3 py-2 bg-background border rounded focus:outline-none focus:ring-2 transition-all ${
                  fieldErrors.email
                    ? "border-red-500 focus:ring-red-500/50"
                    : "border-border focus:ring-primary"
                }`}
                placeholder="your@email.com"
              />
              {fieldErrors.email && (
                <p className="text-red-500 text-xs mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {fieldErrors.email}
                </p>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground py-2 px-4 rounded-lg font-semibold transition transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {loading ? "Saving..." : "Save Profile"}
          </button>
        </form>
      </div>

      {/* Change Password Card */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-xl font-semibold mb-6">Change Password</h3>

        <form onSubmit={handleChangePassword} className="space-y-4">
          {/* Current Password */}
          <div>
            <label
              htmlFor="currentPassword"
              className="block text-sm font-medium mb-2 flex items-center gap-2"
            >
              <Lock className="w-4 h-4" />
              Current Password
            </label>
            <div>
              <input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  clearFieldError("currentPassword");
                }}
                className={`w-full px-3 py-2 bg-background border rounded focus:outline-none focus:ring-2 transition-all ${
                  fieldErrors.currentPassword
                    ? "border-red-500 focus:ring-red-500/50"
                    : "border-border focus:ring-primary"
                }`}
                placeholder="••••••••"
              />
              {fieldErrors.currentPassword && (
                <p className="text-red-500 text-xs mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {fieldErrors.currentPassword}
                </p>
              )}
            </div>
          </div>

          {/* New Password */}
          <div>
            <label
              htmlFor="newPassword"
              className="block text-sm font-medium mb-2 flex items-center gap-2"
            >
              <Lock className="w-4 h-4" />
              New Password
            </label>
            <div>
              <input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  clearFieldError("newPassword");
                }}
                className={`w-full px-3 py-2 bg-background border rounded focus:outline-none focus:ring-2 transition-all ${
                  fieldErrors.newPassword
                    ? "border-red-500 focus:ring-red-500/50"
                    : "border-border focus:ring-primary"
                }`}
                placeholder="••••••••"
              />
              {fieldErrors.newPassword && (
                <p className="text-red-500 text-xs mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {fieldErrors.newPassword}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Must be at least 8 characters
              </p>
            </div>
          </div>

          {/* Confirm Password */}
          <div>
            <label
              htmlFor="confirmPassword"
              className="block text-sm font-medium mb-2 flex items-center gap-2"
            >
              <Lock className="w-4 h-4" />
              Confirm Password
            </label>
            <div>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  clearFieldError("confirmPassword");
                }}
                className={`w-full px-3 py-2 bg-background border rounded focus:outline-none focus:ring-2 transition-all ${
                  fieldErrors.confirmPassword
                    ? "border-red-500 focus:ring-red-500/50"
                    : "border-border focus:ring-primary"
                }`}
                placeholder="••••••••"
              />
              {fieldErrors.confirmPassword && (
                <p className="text-red-500 text-xs mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {fieldErrors.confirmPassword}
                </p>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground py-2 px-4 rounded-lg font-semibold transition transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {loading ? "Updating..." : "Update Password"}
          </button>
        </form>
      </div>
    </div>
  );
}
