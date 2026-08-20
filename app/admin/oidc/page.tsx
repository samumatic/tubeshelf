"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useRouter } from "next/navigation";
import { CheckCircle, XCircle, Loader2, ChevronDown, X } from "lucide-react";

interface OIDCProvider {
  id: string;
  name: string;
  issuer: string;
  baseUrl?: string;
  discoveryUrl?: string;
  domain?: string;
  redirectUri: string;
  clientId: string;
  // clientSecret is never returned from API for security
  scopes?: string;
  autoProvision?: boolean;
  enabled: boolean;
  groupClaimName?: string;
  adminGroupValue?: string;
  createdAt: string;
}

interface AdminOIDCProps {
  onBack?: () => void;
}

export default function AdminOIDC({ onBack }: AdminOIDCProps = {}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [provider, setProvider] = useState<OIDCProvider | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    id: "oidc",
    name: "",
    issuer: "",
    baseUrl: "",
    discoveryUrl: "",
    domain: "",
    clientId: "",
    clientSecret: "",
    scopes: "openid profile email groups",
    autoProvision: false,
    groupClaimName: "",
    adminGroupValue: "",
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [scopeInput, setScopeInput] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingIssuer, setTestingIssuer] = useState(false);
  const [issuerTestResult, setIssuerTestResult] = useState<{
    status: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!loading && (!user || !user.isAdmin)) {
      router.push("/");
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (user?.isAdmin) {
      loadProviders();
    }
  }, [user]);

  const loadProviders = async () => {
    try {
      const response = await fetch("/api/admin/oidc-providers");
      const data = await response.json();
      if (data.providers && data.providers.length > 0) {
        const p = data.providers[0];
        setProvider(p);
        setFormData({
          id: "oidc",
          name: p.name,
          issuer: p.issuer,
          baseUrl: p.baseUrl || "",
          discoveryUrl: p.discoveryUrl || "",
          domain: p.domain || "",
          clientId: p.clientId,
          clientSecret: "",
          scopes: p.scopes || "openid profile email groups",
          autoProvision: p.autoProvision !== undefined ? p.autoProvision : true,
          groupClaimName: p.groupClaimName || "",
          adminGroupValue: p.adminGroupValue || "",
        });
      }
    } catch (err) {
      console.error("Failed to load provider:", err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      // If provider exists, update it. Otherwise create new
      const method = provider ? "PATCH" : "POST";
      const response = await fetch("/api/admin/oidc-providers", {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...formData,
          id: provider?.id || "oidc",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to save provider");
        return;
      }

      setIsEditing(false);
      loadProviders();
    } catch (err) {
      setError("An error occurred");
      console.error("Save provider error:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (!provider) return;
    try {
      await fetch("/api/admin/oidc-providers", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: provider.id,
          enabled: !provider.enabled,
        }),
      });
      loadProviders();
    } catch (err) {
      console.error("Toggle provider error:", err);
    }
  };

  const handleDelete = async () => {
    if (!provider) return;
    if (!confirm("Are you sure you want to delete this OIDC provider?")) {
      return;
    }
    try {
      await fetch("/api/admin/oidc-providers", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: provider.id }),
      });
      setProvider(null);
      setFormData({
        id: "oidc",
        name: "",
        issuer: "",
        baseUrl: "",
        discoveryUrl: "",
        domain: "",
        clientId: "",
        clientSecret: "",
        scopes: "openid profile email groups",
        autoProvision: false,
        groupClaimName: "",
        adminGroupValue: "",
      });
    } catch (err) {
      console.error("Delete provider error:", err);
    }
  };

  const handleTestIssuer = async () => {
    if (!formData.issuer) {
      setIssuerTestResult({
        status: "error",
        message: "Please enter an issuer URL first",
      });
      return;
    }

    setTestingIssuer(true);
    setIssuerTestResult(null);

    try {
      // Try to fetch the OpenID Connect discovery document
      const wellKnownUrl = `${formData.issuer.replace(
        /\/$/,
        ""
      )}/.well-known/openid-configuration`;
      const response = await fetch(wellKnownUrl);

      if (!response.ok) {
        setIssuerTestResult({
          status: "error",
          message: `Failed to fetch discovery document: ${response.status} ${response.statusText}`,
        });
        return;
      }

      const config = await response.json();

      // Verify it has required OIDC fields
      if (
        !config.issuer ||
        !config.authorization_endpoint ||
        !config.token_endpoint
      ) {
        setIssuerTestResult({
          status: "error",
          message:
            "Invalid OIDC discovery document - missing required endpoints",
        });
        return;
      }

      setIssuerTestResult({
        status: "success",
        message: `Valid OIDC provider! Found ${
          Object.keys(config).length
        } configuration fields.`,
      });
    } catch (err: any) {
      setIssuerTestResult({
        status: "error",
        message: err.message || "Failed to connect to issuer URL",
      });
    } finally {
      setTestingIssuer(false);
    }
  };

  // Helper functions for scope tags
  const getScopes = () => {
    return formData.scopes
      .split(" ")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };

  const addScope = (scope: string) => {
    const scopes = getScopes();
    if (!scopes.includes(scope)) {
      setFormData({ ...formData, scopes: [...scopes, scope].join(" ") });
    }
  };

  const removeScope = (scope: string) => {
    const scopes = getScopes().filter((s) => s !== scope);
    setFormData({ ...formData, scopes: scopes.join(" ") });
  };

  const handleScopeInputKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>
  ) => {
    if (e.key === "Enter" || e.key === " " || e.key === ",") {
      e.preventDefault();
      const trimmedInput = scopeInput.trim();
      if (trimmedInput) {
        addScope(trimmedInput);
        setScopeInput("");
      }
    } else if (e.key === "Backspace" && !scopeInput) {
      const scopes = getScopes();
      if (scopes.length > 0) {
        removeScope(scopes[scopes.length - 1]);
      }
    }
  };

  if (loading || !user?.isAdmin) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">OIDC Provider</h1>
          <p className="text-muted-foreground">
            Configure OpenID Connect authentication for your users
          </p>
        </div>

        {error && (
          <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded mb-6 font-medium">
            {error}
          </div>
        )}

        {provider && !isEditing ? (
          <div className="bg-card rounded-lg border border-border shadow-lg p-6">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h3 className="text-xl font-bold">{provider.name}</h3>
                <span
                  className={`inline-block mt-2 px-3 py-1 rounded-full text-xs font-medium ${
                    provider.enabled
                      ? "bg-green-500/10 text-green-500 border border-green-500/20"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {provider.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <button
                onClick={() => setIsEditing(true)}
                className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded font-medium transition cursor-pointer"
              >
                Edit Configuration
              </button>
            </div>

            <div className="space-y-6">
              {/* Basic Configuration */}
              <div>
                <h4 className="text-sm font-semibold text-muted-foreground mb-3">
                  Basic Configuration
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                      Provider Name
                    </label>
                    <div className="px-3 py-2 bg-muted rounded text-sm">
                      {provider.name}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                      Issuer URL
                    </label>
                    <div className="px-3 py-2 bg-muted rounded font-mono text-sm break-all">
                      {provider.issuer}
                    </div>
                  </div>

                  {provider.baseUrl && (
                    <div>
                      <label className="block text-sm font-medium text-muted-foreground mb-1">
                        Base URL
                      </label>
                      <div className="px-3 py-2 bg-muted rounded font-mono text-sm break-all">
                        {provider.baseUrl}
                      </div>
                    </div>
                  )}

                  {provider.discoveryUrl && (
                    <div>
                      <label className="block text-sm font-medium text-muted-foreground mb-1">
                        Discovery URL
                      </label>
                      <div className="px-3 py-2 bg-muted rounded font-mono text-sm break-all">
                        {provider.discoveryUrl}
                      </div>
                    </div>
                  )}

                  {provider.domain && (
                    <div>
                      <label className="block text-sm font-medium text-muted-foreground mb-1">
                        Domain
                      </label>
                      <div className="px-3 py-2 bg-muted rounded font-mono text-sm">
                        {provider.domain}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Client Configuration */}
              <div className="border-t border-border pt-4">
                <h4 className="text-sm font-semibold text-muted-foreground mb-3">
                  Client Configuration
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                      Client ID
                    </label>
                    <div className="px-3 py-2 bg-muted rounded font-mono text-sm">
                      {provider.clientId}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                      Client Secret
                    </label>
                    <div className="px-3 py-2 bg-muted rounded font-mono text-sm text-muted-foreground">
                      •••••••• (hidden for security)
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1">
                      Scopes
                    </label>
                    <div className="px-3 py-2 bg-muted rounded font-mono text-sm">
                      {provider.scopes || "openid profile email groups"}
                    </div>
                  </div>
                </div>
              </div>

              {/* Authentication Settings */}
              <div className="border-t border-border pt-4">
                <h4 className="text-sm font-semibold text-muted-foreground mb-3">
                  Authentication Settings
                </h4>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded">
                    <span className="text-sm">Auto-provisioning:</span>
                    <span
                      className={`text-sm font-medium ${
                        provider.autoProvision
                          ? "text-green-500"
                          : "text-muted-foreground"
                      }`}
                    >
                      {provider.autoProvision !== false
                        ? "Enabled"
                        : "Disabled"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Group Claims */}
              {(provider.groupClaimName || provider.adminGroupValue) && (
                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-semibold text-muted-foreground mb-3">
                    Auto-Admin Configuration
                  </h4>
                  <div className="space-y-3">
                    {provider.groupClaimName && (
                      <div>
                        <label className="block text-sm font-medium text-muted-foreground mb-1">
                          Group Claim Name
                        </label>
                        <div className="px-3 py-2 bg-muted rounded font-mono text-sm">
                          {provider.groupClaimName}
                        </div>
                      </div>
                    )}

                    {provider.adminGroupValue && (
                      <div>
                        <label className="block text-sm font-medium text-muted-foreground mb-1">
                          Admin Group Value
                        </label>
                        <div className="px-3 py-2 bg-muted rounded font-mono text-sm">
                          {provider.adminGroupValue}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-6 pt-6 border-t border-border">
              <button
                onClick={handleToggle}
                className={`flex-1 px-4 py-2 rounded font-medium transition cursor-pointer ${
                  provider.enabled
                    ? "bg-muted hover:bg-muted/80 text-foreground"
                    : "bg-primary hover:bg-primary/90 text-primary-foreground"
                }`}
              >
                {provider.enabled ? "Disable" : "Enable"} Provider
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 bg-destructive/10 hover:bg-destructive/20 text-destructive rounded font-medium transition cursor-pointer border border-destructive/20"
              >
                Delete
              </button>
            </div>
          </div>
        ) : null}

        {isEditing && (
          <div className="bg-card rounded-lg border border-border shadow-lg p-6">
            <h2 className="text-xl font-bold mb-6">
              {provider ? "Edit" : "Configure"} OIDC Provider
            </h2>

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Info Box */}
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
                <p className="text-sm text-muted-foreground">
                  <strong className="text-foreground">Redirect URI:</strong>{" "}
                  Configure this URL in your OIDC provider&apos;s settings:
                  <br />
                  <code className="font-mono text-xs bg-muted px-2 py-1 rounded mt-1 inline-block">
                    {typeof window !== "undefined"
                      ? `${window.location.protocol}//${window.location.host}/api/auth/oidc/callback`
                      : "https://your-domain.com/api/auth/oidc/callback"}
                  </code>
                </p>
              </div>

              {/* Provider Name */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Provider Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  required
                  className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="My Company SSO"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Name shown to users on the login page
                </p>
              </div>

              {/* Issuer URL */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Issuer URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={formData.issuer}
                    onChange={(e) => {
                      setFormData({ ...formData, issuer: e.target.value });
                      setIssuerTestResult(null);
                    }}
                    required
                    className="flex-1 px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary font-mono text-sm"
                    placeholder="https://auth.example.com"
                  />
                  <button
                    type="button"
                    onClick={handleTestIssuer}
                    disabled={testingIssuer || !formData.issuer}
                    className="px-4 py-2 bg-secondary hover:bg-secondary/80 text-foreground rounded font-medium transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                  >
                    {testingIssuer ? (
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Testing...
                      </span>
                    ) : (
                      "Test Connection"
                    )}
                  </button>
                </div>
                {issuerTestResult && (
                  <div
                    className={`mt-2 px-3 py-2 rounded text-sm flex items-start gap-2 ${
                      issuerTestResult.status === "success"
                        ? "bg-green-500/10 text-green-500 border border-green-500/20"
                        : "bg-destructive/10 text-destructive border border-destructive/20"
                    }`}
                  >
                    {issuerTestResult.status === "success" ? (
                      <CheckCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    )}
                    <span>{issuerTestResult.message}</span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Base URL of your OIDC provider
                </p>
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Base URL (Optional)
                </label>
                <input
                  type="url"
                  value={formData.baseUrl}
                  onChange={(e) =>
                    setFormData({ ...formData, baseUrl: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary font-mono text-sm"
                  placeholder="https://auth.example.com"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Override the base URL if different from issuer
                </p>
              </div>

              {/* Discovery URL */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Discovery URL (Optional)
                </label>
                <input
                  type="url"
                  value={formData.discoveryUrl}
                  onChange={(e) =>
                    setFormData({ ...formData, discoveryUrl: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary font-mono text-sm"
                  placeholder="https://auth.example.com/.well-known/openid-configuration"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Override only if your provider uses a non-standard path
                </p>
              </div>

              {/* Domain */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Domain (Optional)
                </label>
                <input
                  type="text"
                  value={formData.domain}
                  onChange={(e) =>
                    setFormData({ ...formData, domain: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="example.com"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Restrict authentication to specific domain
                </p>
              </div>

              {/* Client ID */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Client ID
                </label>
                <input
                  type="text"
                  value={formData.clientId}
                  onChange={(e) =>
                    setFormData({ ...formData, clientId: e.target.value })
                  }
                  required
                  className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary font-mono text-sm"
                  placeholder="tubeshelf"
                />
              </div>

              {/* Client Secret */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Client Secret
                </label>
                <input
                  type="password"
                  value={formData.clientSecret}
                  onChange={(e) =>
                    setFormData({ ...formData, clientSecret: e.target.value })
                  }
                  required={!provider}
                  autoComplete="off"
                  className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary font-mono text-sm"
                  placeholder={
                    provider
                      ? "Leave empty to keep current secret"
                      : "••••••••••••••••"
                  }
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {provider
                    ? "Only enter if you want to update the secret"
                    : "Stored securely and never displayed after creation"}
                </p>
              </div>

              {/* Scopes */}
              <div>
                <label className="block text-sm font-medium mb-2">Scopes</label>
                <div className="w-full px-3 py-2 bg-background border border-border rounded focus-within:ring-2 focus-within:ring-primary min-h-[42px] flex flex-wrap gap-2 items-center">
                  {getScopes().map((scope) => (
                    <span
                      key={scope}
                      className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary rounded text-sm font-mono"
                    >
                      {scope}
                      <button
                        type="button"
                        onClick={() => removeScope(scope)}
                        className="hover:bg-primary/20 rounded p-0.5 transition cursor-pointer"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    value={scopeInput}
                    onChange={(e) => setScopeInput(e.target.value)}
                    onKeyDown={handleScopeInputKeyDown}
                    className="flex-1 min-w-[120px] bg-transparent outline-none font-mono text-sm"
                    placeholder={
                      getScopes().length === 0
                        ? "openid profile email groups"
                        : "Add scope..."
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  OAuth scopes to request. Press Enter, Space, or Comma to add a
                  scope.
                </p>
              </div>

              {/* Auto-provisioning */}
              <div className="flex items-start gap-3 p-4 bg-muted/50 rounded-lg border border-border">
                <input
                  type="checkbox"
                  id="autoProvision"
                  checked={formData.autoProvision}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      autoProvision: e.target.checked,
                    })
                  }
                  className="mt-1 h-4 w-4 rounded border-border cursor-pointer"
                />
                <div className="flex-1">
                  <label
                    htmlFor="autoProvision"
                    className="block text-sm font-medium cursor-pointer"
                  >
                    Allow auto-provisioning
                  </label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Automatically create accounts for new users. If disabled,
                    users must exist before they can sign in.
                  </p>
                </div>
              </div>

              {/* Enable Provider */}
              <div className="flex items-start gap-3 p-4 bg-muted/50 rounded-lg border border-border">
                <input
                  type="checkbox"
                  id="enabled"
                  checked={provider?.enabled ?? true}
                  onChange={(e) => {
                    if (provider) {
                      setProvider({ ...provider, enabled: e.target.checked });
                    }
                  }}
                  className="mt-1 h-4 w-4 rounded border-border cursor-pointer"
                />
                <div className="flex-1">
                  <label
                    htmlFor="enabled"
                    className="block text-sm font-medium cursor-pointer"
                  >
                    Enable provider
                  </label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Allow users to authenticate with this provider
                  </p>
                </div>
              </div>

              {/* Advanced Settings */}
              <div className="border-t border-border pt-6">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="w-full flex items-center justify-between text-left group cursor-pointer"
                >
                  <h3 className="text-lg font-semibold">Advanced Settings</h3>
                  <ChevronDown
                    className={`h-5 w-5 text-muted-foreground transition-transform ${
                      showAdvanced ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {showAdvanced && (
                  <div className="mt-6 space-y-6">
                    {/* Auto-Admin from Group Claims */}
                    <div>
                      <h4 className="text-sm font-semibold mb-2">
                        Auto-Admin from Group Claims
                      </h4>
                      <p className="text-sm text-muted-foreground mb-4">
                        Automatically grant admin role to users who have a
                        specific group claim in their OIDC token.
                      </p>

                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium mb-2">
                            Group Claim Name
                          </label>
                          <input
                            type="text"
                            value={formData.groupClaimName}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                groupClaimName: e.target.value,
                              })
                            }
                            className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary font-mono text-sm"
                            placeholder="groups"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            Name of the claim containing user groups (e.g.,
                            groups, roles, memberOf)
                          </p>
                        </div>

                        <div>
                          <label className="block text-sm font-medium mb-2">
                            Admin Group Value
                          </label>
                          <input
                            type="text"
                            value={formData.adminGroupValue}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                adminGroupValue: e.target.value,
                              })
                            }
                            className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary font-mono text-sm"
                            placeholder="admins"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            Users with this group will be granted admin role
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-4 flex gap-3 border-t border-border">
                {provider && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditing(false);
                      setError("");
                    }}
                    className="flex-1 px-4 py-2 bg-muted hover:bg-muted/80 text-foreground rounded font-medium transition cursor-pointer"
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {saving
                    ? "Saving..."
                    : provider
                    ? "Save Changes"
                    : "Create Provider"}
                </button>
              </div>
            </form>
          </div>
        )}

        {!provider && !isEditing && (
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-4">
              No OIDC provider configured.
            </p>
            <button
              onClick={() => setIsEditing(true)}
              className="px-6 py-3 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition cursor-pointer"
            >
              Configure OIDC Provider
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
