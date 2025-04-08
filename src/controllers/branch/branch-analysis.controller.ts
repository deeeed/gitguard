import { GitService } from "../../services/git.service.js";
import { GitHubService } from "../../services/github.service.js";
import { PRService } from "../../services/pr.service.js";
import { PRAnalysisResult } from "../../types/analysis.types.js";
import { Config } from "../../types/config.types.js";
import { FileChange } from "../../types/git.types.js";
import { Logger } from "../../types/logger.types.js";
import { FileUtil } from "../../utils/file.util.js";

interface BranchAnalysisControllerParams {
  logger: Logger;
  git: GitService;
  github: GitHubService;
  config: Config;
  prService: PRService;
}

interface BranchValidationResult {
  isValid: boolean;
  isUpToDate: boolean;
  existsLocally: boolean;
  existsRemotely: boolean;
  errors: string[];
  warnings: string[];
}

export class BranchAnalysisController {
  private readonly logger: Logger;
  private readonly git: GitService;

  constructor({ logger, git }: BranchAnalysisControllerParams) {
    this.logger = logger;
    this.git = git;
  }

  async analyzeBranch(params: {
    branchToAnalyze: string;
    enableAI?: boolean;
  }): Promise<PRAnalysisResult> {
    this.logger.info(`\n🔍 Analyzing branch: ${params.branchToAnalyze}`);

    // Get the default branch systematically 
    const defaultBranch = await this.git.getDefaultBranch();
    
    // Prevent analysis on default branch
    if (params.branchToAnalyze === defaultBranch) {
      throw new Error(
        `Cannot analyze the base branch (${defaultBranch}). Please create and switch to a feature branch first.`,
      );
    }

    const validation = await this.validateBranchContext({
      branchToAnalyze: params.branchToAnalyze,
    });
    if (!validation.isValid) {
      throw new Error(
        `Branch validation failed: ${validation.errors.join(", ")}`,
      );
    }

    // Get commits between branches first
    const commits = await this.git.getCommits({
      from: defaultBranch,
      to: params.branchToAnalyze,
    });
    
    this.logger.debug(`Found ${commits.length} commits between ${defaultBranch} and ${params.branchToAnalyze}`);
    
    // If no commits found, try an alternative approach
    if (commits.length === 0) {
      this.logger.warn(`No commits found between ${defaultBranch} and ${params.branchToAnalyze}. This could mean:
      1. ${defaultBranch} branch doesn't exist
      2. There are no differences between the branches
      3. The branches have no common ancestry`);
      
      try {
        // Just get the commits in the current branch to have some context
        const branchCommits = await this.git.execGit({
          command: "log",
          args: [
            "--format=%H%n%an%n%aI%n%B%n--END--",
            params.branchToAnalyze,
            "--max-count=10", // Limit to 10 commits
            "--no-merges"
          ],
        });
        
        if (branchCommits.trim()) {
          const parsedCommits = this.git["parser"].parseCommitLog({ log: branchCommits });
          if (parsedCommits.length > 0) {
            this.logger.info(`Using the last ${parsedCommits.length} commits from ${params.branchToAnalyze} instead`);
            return this.createAnalysisResult({
              branchToAnalyze: params.branchToAnalyze,
              baseBranch: defaultBranch,
              commits: parsedCommits,
              files: [], // No file diff available
              diff: "",
            });
          }
        }
      } catch (error) {
        this.logger.debug("Failed to get branch commits as fallback:", error);
      }
    }

    // Get branch diff data
    let files: FileChange[] = [];
    let diff = "";
    
    try {
      // First try to get the diff directly using the GitService's getDiff method
      // This is safer as we've added branch existence checks there
      diff = await this.git.getDiff({
        type: "range",
        from: defaultBranch,
        to: params.branchToAnalyze,
      });
      
      if (!diff) {
        throw new Error("Empty diff result");
      }
      
      // Get diff stats for file changes
      const diffStats = await this.git.execGit({
        command: "diff",
        args: [`${defaultBranch}`, `${params.branchToAnalyze}`, "--numstat"],
      }).catch(error => {
        this.logger.debug("Failed to get numstat diff:", error);
        return "";
      });

      // Parse the diff stats into FileChange objects if we have them
      if (diffStats) {
        files = diffStats
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [additions = "0", deletions = "0", path = ""] = line.split(/\s+/);
            return {
              path,
              status: "modified",
              additions: parseInt(additions, 10),
              deletions: parseInt(deletions, 10),
              ...FileUtil.getFileType({ path }),
            };
          });
      }
    } catch (error) {
      this.logger.debug("Failed to get direct diff, trying with origin/:", error);
      
      // Fallback to using origin/ prefix if direct branch comparison failed
      try {
        const diffStats = await this.git.execGit({
          command: "diff",
          args: [`origin/${defaultBranch}...${params.branchToAnalyze}`, "--numstat"],
        }).catch(error => {
          this.logger.debug("Failed to get numstat diff with origin/:", error);
          return "";
        });

        if (diffStats) {
          files = diffStats
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [additions = "0", deletions = "0", path = ""] = line.split(/\s+/);
              return {
                path,
                status: "modified",
                additions: parseInt(additions, 10),
                deletions: parseInt(deletions, 10),
                ...FileUtil.getFileType({ path }),
              };
            });
          
          // Get the complete diff content
          diff = await this.git.execGit({
            command: "diff",
            args: [`origin/${defaultBranch}...${params.branchToAnalyze}`],
          }).catch(() => "");
        }
      } catch (innerError) {
        this.logger.debug("All diff methods failed:", innerError);
      }
    }

    return this.createAnalysisResult({
      branchToAnalyze: params.branchToAnalyze,
      baseBranch: defaultBranch,
      commits,
      files,
      diff,
    });
  }
  
  // Helper method to create a consistent analysis result
  private createAnalysisResult(params: {
    branchToAnalyze: string;
    baseBranch: string;
    commits: any[];
    files: FileChange[];
    diff: string;
  }): PRAnalysisResult {
    const { branchToAnalyze, baseBranch, commits, files, diff } = params;
    
    // Group files by directory
    const filesByDirectory = files.reduce(
      (acc, file) => {
        const directory = file.path.split("/")[0];
        if (!acc[directory]) {
          acc[directory] = [];
        }
        acc[directory].push(file.path);
        return acc;
      },
      {} as Record<string, string[]>,
    );
    
    return {
      branch: branchToAnalyze,
      baseBranch,
      commits,
      stats: {
        totalCommits: commits.length,
        filesChanged: files.length,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
        authors: [...new Set(commits.map((c) => c.author))],
        timeSpan: {
          firstCommit: commits[commits.length - 1]?.date ?? new Date(),
          lastCommit: commits[0]?.date ?? new Date(),
        },
      },
      warnings: [],
      filesByDirectory,
      files,
      diff,
    };
  }

  async validateBranchContext({
    branchToAnalyze,
  }: {
    branchToAnalyze: string;
  }): Promise<BranchValidationResult> {
    this.logger.info("\n🔎 Validating branch context...");

    const result: BranchValidationResult = {
      isValid: true,
      isUpToDate: true,
      existsLocally: false,
      existsRemotely: false,
      errors: [],
      warnings: [],
    };

    try {
      const localBranches = await this.git.getLocalBranches();
      const remoteBranches = localBranches.filter((b) =>
        b.startsWith("origin/"),
      );

      result.existsLocally = localBranches.includes(branchToAnalyze);
      result.existsRemotely = remoteBranches.includes(
        `origin/${branchToAnalyze}`,
      );

      if (!result.existsLocally) {
        if (result.existsRemotely) {
          result.errors.push(
            `Branch '${branchToAnalyze}' exists remotely but needs to be checked out locally first`,
          );
        } else {
          result.errors.push(
            `Branch '${branchToAnalyze}' not found locally or remotely`,
          );
        }
        result.isValid = false;
        return result;
      }

      // Check if branch is up to date with remote
      if (result.existsLocally && result.existsRemotely) {
        const localCommit = await this.git.execGit({
          command: "rev-parse",
          args: [branchToAnalyze],
        });
        const remoteCommit = await this.git.execGit({
          command: "rev-parse",
          args: [`origin/${branchToAnalyze}`],
        });

        result.isUpToDate = localCommit.trim() === remoteCommit.trim();
        if (!result.isUpToDate) {
          result.warnings.push(
            `Branch '${branchToAnalyze}' is not up to date with remote`,
          );
        }
      }

      return result;
    } catch (error) {
      this.logger.error("Failed to validate branch context:", error);
      result.isValid = false;
      result.errors.push(
        `Failed to validate branch: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }
  }
}
