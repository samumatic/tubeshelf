"use client";

import { useState, useRef, useContext, useEffect } from "react";
import { ThemeContext } from "@/components/ThemeProvider";
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Upload,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface WelcomeWizardProps {
  onComplete: (options: WelcomeOptions) => void;
  onSkip: () => void;
  onImportFile?: (file: File) => Promise<void>;
}

export interface WelcomeOptions {
  userAcceptedWelcome: boolean;
  fetchMethod: "standard" | "rss";
}

export function WelcomeWizard({
  onComplete,
  onSkip,
  onImportFile,
}: WelcomeWizardProps) {
  const { theme } = useContext(ThemeContext);
  const [mounted, setMounted] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<WelcomeOptions>({
    userAcceptedWelcome: true,
    fetchMethod: "standard",
  });
  const [wantToImport, setWantToImport] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleFileSelect = async (file: File) => {
    if (!onImportFile) return;

    setIsImporting(true);
    setImportError(null);
    setImportSuccess(false);
    try {
      await onImportFile(file);
      setImportSuccess(true);
      // Don't auto-advance - let user click Next when ready
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "Failed to import file"
      );
    } finally {
      setIsImporting(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const steps = [
    {
      title: "Welcome to TubeShelf",
      description:
        "A clean, chronological YouTube feed. No algorithm. No tracking.",
      content: (
        <div className="text-center space-y-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded">
            <img
              src={(() => {
                if (theme === "dark") return "/icon-dark.svg";
                if (theme === "light") return "/icon-light.svg";
                // system theme
                const prefersDark =
                  typeof window !== "undefined" &&
                  window.matchMedia("(prefers-color-scheme: dark)").matches;
                return prefersDark ? "/icon-dark.svg" : "/icon-light.svg";
              })()}
              alt="TubeShelf"
              className={`h-24 w-24 transition-opacity duration-300 ${
                mounted ? "opacity-100" : "opacity-0"
              }`}
            />
          </div>
          <div className="space-y-3">
            <p className="text-lg font-medium text-foreground">
              Let&apos;s get your feed set up
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We&apos;ll ask you a few quick questions to customize your experience.
            </p>
            <p className="text-xs text-muted-foreground">
              You can change these settings anytime in Settings.
            </p>
          </div>
        </div>
      ),
    },
    {
      title: "Import Subscriptions",
      description: "Do you want to import subscriptions?",
      content: (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">
            Import from OPML or TubeShelf XML files to populate your feed
            instantly.
          </p>
          <div className="space-y-3">
            <label className="flex items-center gap-4 p-4 border border-border rounded-xl cursor-pointer hover:bg-secondary/50 transition-all hover:border-primary/50 group">
              <input
                type="radio"
                name="import"
                checked={wantToImport}
                onChange={() => setWantToImport(true)}
                className="w-5 h-5 cursor-pointer accent-primary"
              />
              <div className="flex-1">
                <p className="font-semibold text-foreground group-hover:text-primary transition-colors">
                  Yes, import subscriptions
                </p>
                <p className="text-sm text-muted-foreground">
                  I have an OPML or TubeShelf XML file
                </p>
              </div>
              <span className="text-xl">📁</span>
            </label>
            <label className="flex items-center gap-4 p-4 border border-border rounded-xl cursor-pointer hover:bg-secondary/50 transition-all hover:border-primary/50 group">
              <input
                type="radio"
                name="import"
                checked={!wantToImport}
                onChange={() => setWantToImport(false)}
                className="w-5 h-5 cursor-pointer accent-primary"
              />
              <div className="flex-1">
                <p className="font-semibold text-foreground group-hover:text-primary transition-colors">
                  No, skip for now
                </p>
                <p className="text-sm text-muted-foreground">
                  I&apos;ll add subscriptions later
                </p>
              </div>
              <span className="text-xl">➕</span>
            </label>
          </div>
        </div>
      ),
    },
    {
      title: "Upload Subscriptions",
      description: "Import your subscription file",
      content: (
        <div className="space-y-4">
          {importSuccess && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 text-sm text-green-700 dark:text-green-400 flex items-center gap-3 animate-in fade-in">
              <Check className="w-5 h-5 flex-shrink-0" />
              <span className="font-medium">
                Subscriptions imported successfully!
              </span>
            </div>
          )}
          {importError && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm text-destructive font-medium">
              ⚠️ {importError}
            </div>
          )}
          {isImporting && (
            <div className="text-center py-6">
              <p className="text-muted-foreground">
                Importing subscriptions...
              </p>
            </div>
          )}
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className="border-2 border-dashed border-primary/30 rounded-xl p-10 text-center hover:bg-primary/5 transition-all cursor-pointer group"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-10 h-10 text-primary/60 group-hover:text-primary mx-auto mb-4 transition-colors" />
            <p className="font-semibold text-foreground mb-1">
              Drop your file here
            </p>
            <p className="text-sm text-muted-foreground mb-3">
              or click to browse
            </p>
            <p className="text-xs text-muted-foreground">
              Supports OPML and TubeShelf XML files
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".opml,.xml"
              onChange={handleFileInputChange}
              className="hidden"
            />
          </div>
          <div className="bg-secondary/50 rounded-lg p-3 border border-border/50">
            <p className="text-xs text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Tip:</strong> You can import
              multiple files here. All subscriptions will be combined. Later,
              you can organize them into separate lists in the subscription
              manager.
            </p>
          </div>
        </div>
      ),
    },
    {
      title: "Feed Loading Method",
      description: "Choose your preferred loading speed",
      content: (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground leading-relaxed">
            <strong className="text-foreground">
              Choose how to load your feed.
            </strong>{" "}
            Fast mode is quicker but shows less information. You can change this
            anytime in settings.
          </p>
          <div className="space-y-3">
            <label className="flex items-start gap-4 p-4 border border-border rounded-xl cursor-pointer hover:bg-secondary/50 transition-all hover:border-primary/50 group">
              <input
                type="radio"
                name="fetchMethod"
                checked={options.fetchMethod === "standard"}
                onChange={() =>
                  setOptions({ ...options, fetchMethod: "standard" })
                }
                className="w-5 h-5 mt-0.5 cursor-pointer accent-primary"
              />
              <div className="flex-1">
                <p className="font-semibold text-foreground group-hover:text-primary transition-colors mb-1">
                  Default Mode
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Comprehensive fetching with full metadata (duration, views,
                  etc.). Slower but more complete.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-4 p-4 border border-border rounded-xl cursor-pointer hover:bg-secondary/50 transition-all hover:border-primary/50 group">
              <input
                type="radio"
                name="fetchMethod"
                checked={options.fetchMethod === "rss"}
                onChange={() => setOptions({ ...options, fetchMethod: "rss" })}
                className="w-5 h-5 mt-0.5 cursor-pointer accent-primary"
              />
              <div className="flex-1">
                <p className="font-semibold text-foreground group-hover:text-primary transition-colors mb-1">
                  Fast Mode
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Using YouTube&apos;s RSS feed. Much faster but lacks duration/view
                  count and may return fewer items (~15 recent videos).
                </p>
              </div>
            </label>
          </div>
          <div className="bg-secondary/50 rounded-lg p-3 border border-border/50">
            <p className="text-xs text-muted-foreground leading-relaxed">
              <strong className="text-foreground">The choice:</strong> Speed or
              complete information. You can change this anytime in settings.
            </p>
          </div>
        </div>
      ),
    },
    {
      title: "Ready to Go!",
      description: "All set up and ready to start",
      content: (
        <div className="text-center space-y-6">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-green-500/10 rounded">
            <Check className="w-8 h-8 text-green-600 dark:text-green-400" />
          </div>
          <div className="space-y-2">
            <p className="font-semibold text-foreground">
              Your feed is configured!
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              All settings have been saved. You&apos;re ready to start exploring your
              chronological YouTube feed.
            </p>
          </div>
        </div>
      ),
    },
  ];

  const step = steps[currentStep];
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === steps.length - 1;

  // Calculate total visible steps for progress bar
  const totalSteps = wantToImport ? steps.length : steps.length - 1;

  const handleNext = () => {
    if (isLastStep) {
      onComplete(options);
    } else {
      // Skip upload step (index 2) if not importing
      if (currentStep === 1 && !wantToImport) {
        setCurrentStep(3); // Jump to fetch method step
      } else {
        setCurrentStep(currentStep + 1);
      }
    }
  };

  const handleBack = () => {
    // Skip upload step (index 2) when going back if not importing
    if (currentStep === 3 && !wantToImport) {
      setCurrentStep(1); // Jump back to import question step
    } else {
      setCurrentStep(currentStep - 1);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-br from-primary/20 via-primary/10 to-transparent px-8 py-10 border-b border-border/50">
          <div className="space-y-3">
            <div className="inline-block">
              <span className="text-xs font-semibold text-primary bg-primary/10 px-3 py-1 rounded-full">
                Step{" "}
                {wantToImport || currentStep < 2
                  ? currentStep + 1
                  : currentStep}{" "}
                of {totalSteps}
              </span>
            </div>
            <h2 className="text-3xl font-bold text-foreground">{step.title}</h2>
            <p className="text-sm text-muted-foreground/90">
              {step.description}
            </p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="h-1 bg-secondary">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{
              width: `${
                ((wantToImport || currentStep < 2
                  ? currentStep + 1
                  : currentStep) /
                  totalSteps) *
                100
              }%`,
            }}
          />
        </div>

        {/* Content */}
        <div className="px-8 py-10 min-h-72 max-h-96 overflow-y-auto">
          {step.content}
        </div>

        {/* Footer */}
        <div className="px-8 py-6 border-t border-border/50 bg-card/50 flex gap-3 justify-between">
          <Button
            variant="ghost"
            onClick={onSkip}
            className="text-muted-foreground hover:text-foreground"
          >
            Skip
          </Button>
          <div className="flex gap-3">
            {!isFirstStep && (
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={isImporting}
                className="min-w-32"
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
            )}
            <Button
              onClick={handleNext}
              disabled={isImporting}
              className="min-w-32"
            >
              {isLastStep ? "Get Started" : "Next"}
              {!isLastStep && <ChevronRight className="w-4 h-4 ml-1" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
