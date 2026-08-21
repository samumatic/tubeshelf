#!/usr/bin/env node

// Set CLI mode to suppress migration logs
process.env.CLI_MODE = 'true';

/**
 * CLI entry point for tubeshelf
 * Usage:
 *   node cli.js reset-password <email>
 *   node cli.js toggle-oidc-only [enable|disable]
 *   node cli.js get-oidc-only
 *   node cli.js list-local-users
 */

import { executeCLICommand } from "../lib/cli.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    console.log(`
Tubeshelf CLI Management Tool

Usage:
  tubeshelf-cli <command> [options]

User Management:
  user-list                             List all local users
  user-reset-password <email>           Reset the password for a local user
                                        A random 16-letter password will be generated and displayed

OIDC Configuration:
  oidc-status                           Show current OIDC-only login mode status
  oidc-toggle [enable|disable]          Toggle OIDC-only login mode
                                        enable   - Enable OIDC-only login (local passwords disabled)
                                        disable  - Disable OIDC-only login (allow both OIDC and local passwords)
                                        no arg   - Toggle current setting

Examples:
  tubeshelf-cli user-list
  tubeshelf-cli user-reset-password admin@example.com
  tubeshelf-cli oidc-status
  tubeshelf-cli oidc-toggle enable
      `);
    process.exit(0);
  }

  try {
    const result = await executeCLICommand(args);

    if (result.data) {
      console.log(result.message);
      if (Array.isArray(result.data)) {
        console.log("\nUsers:");
        result.data.forEach((user) => {
          const adminLabel = user.isAdmin ? " (ADMIN)" : "";
          const nameDisplay = user.name ? ` - ${user.name}` : "";
          console.log(`  ${user.email}${nameDisplay}${adminLabel}`);
        });
      } else {
        console.log(JSON.stringify(result.data, null, 2));
      }
    } else {
      console.log(result.message);
    }
    
    // Display generated password if present
    if (result.password) {
      console.log("\n" + "=".repeat(50));
      console.log("Generated Password: " + result.password);
      console.log("=".repeat(50));
      console.log("\n⚠️  Save this password securely - it will not be shown again!");
    }

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    console.error(
      "Error:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

main();
