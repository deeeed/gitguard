import { BranchCommandOptions } from "../../commands/branch.js";
import { GitService } from "../../services/git.service.js";
import { GitHubService } from "../../services/github.service.js";
import { LoggerService } from "../../services/logger.service.js";
import { PRService } from "../../services/pr.service.js";
import { ReporterService } from "../../services/reporter.service.js";
import { SecurityService } from "../../services/security.service.js";
import { AIProvider } from "../../types/ai.types.js";
import { PRAnalysisResult } from "../../types/analysis.types.js";
import { Config, GitConfig } from "../../types/config.types.js";
import { SecurityCheckResult } from "../../types/security.types.js";
import { TemplateRegistry } from "../../services/template/template-registry.js";
import { initializeAI } from "../../utils/ai-init.util.js";
import { loadConfig } from "../../utils/config.util.js";
import { BranchAIController } from "./branch-ai.controller.js";
import { BranchAnalysisController } from "./branch-analysis.controller.js";
import { BranchPRController } from "./branch-pr.controller.js";
import { BranchSecurityController } from "./branch-security.controller.js";
import { BranchSplitController } from "./branch-split.controller.js";
import { determineDefaultBranch } from "../../utils/git.util.js";

interface AnalyzeParams {
  options: BranchCommandOptions;
  subCommandOptions?: Partial<BranchCommandOptions>;
}

interface ServicesContext {
  logger: LoggerService;
  reporter: ReporterService;
  git: GitService;
  github: GitHubService;
  security: SecurityService;
  ai?: AIProvider;
  prService: PRService;
  config: Config;
  isAIEnabled: boolean;
}

interface ControllersContext {
  analysisController: BranchAnalysisController;
  aiController: BranchAIController;
  prController: BranchPRController;
  securityController: BranchSecurityController;
  splitController: BranchSplitController;
}

interface InitializeServicesParams {
  options: BranchCommandOptions;
  subCommandOptions?: Partial<BranchCommandOptions>;
}

interface InitializeControllersParams {
  services: ServicesContext;
}

interface InitializeAnalysisContextParams {
  services: ServicesContext;
  options: BranchCommandOptions;
}

interface AnalysisContext {
  branchToAnalyze: string;
  baseBranch: string;
}

interface ProcessAIParams {
  controllers: ControllersContext;
  analysisResult: PRAnalysisResult;
  options: BranchCommandOptions;
  logger: LoggerService;
}

interface HandlePRParams {
  controllers: ControllersContext;
  options: BranchCommandOptions;
  analysisResult: PRAnalysisResult;
  analysisContext: AnalysisContext;
}

interface SecurityCheckParams {
  controllers: ControllersContext;
  analysisResult: PRAnalysisResult;
}

interface InitialAnalysisParams {
  controllers: ControllersContext;
  context: AnalysisContext;
}

interface ProcessAIWithGitHubParams {
  controllers: ControllersContext;
  analysisResult: PRAnalysisResult;
  options: BranchCommandOptions;
}

async function initializeServices({
  options,
  subCommandOptions = {},
}: InitializeServicesParams): Promise<ServicesContext> {
  
  const mergedOptions = { ...options, ...subCommandOptions };
  
  const isDebug = mergedOptions.debug ?? process.env.GITGUARD_DEBUG === "true";
  const logger = new LoggerService({ debug: isDebug });
  const reporter = new ReporterService({ logger });

  logger.info("\n🚀 Initializing GitGuard services...");

  const config = await loadConfig({ configPath: mergedOptions.configPath });
  const gitConfig: GitConfig = {
    ...config.git,
    github: config.git.github,
    monorepoPatterns: config.git.monorepoPatterns || [],
  };
  
  if (mergedOptions.base) {
    gitConfig.baseBranch = mergedOptions.base;
    logger.debug(`Using command-line base branch: ${gitConfig.baseBranch}`);
  } else if (!config.git.baseBranch || config.git.baseBranch === null) {
    const defaultBranch = await determineDefaultBranch({
      command: "rev-parse",
      args: ["--abbrev-ref", "HEAD"],
      logger
    });
    
    gitConfig.baseBranch = defaultBranch;
    logger.debug("Auto-detected base branch:", gitConfig.baseBranch);
  } else {
    logger.info("Using configured base branch:", gitConfig.baseBranch);
  }
  
  const git = new GitService({ gitConfig, logger });
  const github = new GitHubService({ config, logger, git });
  const security = new SecurityService({ config, logger });

  const isAIEnabled =
    mergedOptions.ai === undefined
      ? (config.ai?.enabled ?? false)
      : (mergedOptions.ai ?? true);
  const ai = initializeAI({ config, logger, isAIRequested: isAIEnabled });

  const prService = new PRService({
    config,
    logger,
    git,
    github,
    security,
    ai,
  });

  logger.debug("✅ Services initialized successfully");
  return {
    logger,
    reporter,
    git,
    github,
    security,
    ai,
    prService,
    config,
    isAIEnabled: isAIEnabled,
  };
}

async function initializeControllers({
  services,
}: InitializeControllersParams): Promise<ControllersContext> {
  const { logger, git, github, prService, config, ai } = services;

  const templateRegistry = new TemplateRegistry({
    logger,
    gitRoot: git.getCWD(),
  });
  await templateRegistry.loadTemplates({ includeDefaults: true });

  return {
    analysisController: new BranchAnalysisController({
      logger,
      git,
      github,
      config,
      prService,
    }),
    aiController: new BranchAIController({
      logger,
      ai,
      git,
      prService,
      github,
      config,
      templateRegistry,
    }),
    prController: new BranchPRController({
      logger,
      git,
      github,
      prService,
      config,
    }),
    securityController: new BranchSecurityController({
      logger,
      security: services.security,
      git,
    }),
    splitController: new BranchSplitController({
      logger,
      git,
      prService,
      config,
    }),
  };
}

export async function analyzeBranch({
  options,
  subCommandOptions,
}: AnalyzeParams): Promise<PRAnalysisResult> {
  const services = await initializeServices({ options, subCommandOptions });
  const { logger, reporter, config } = services;
  
  const combinedOptions = { ...options, ...subCommandOptions } as BranchCommandOptions;

  try {
    logger.debug("Analysis combined options:", {
      full: combinedOptions,
      split: combinedOptions.split,
      splitType: typeof combinedOptions.split,
    });

    logger.info("\n🎯 Starting branch analysis...");
    const controllers = await initializeControllers({ services });

    const analysisContext = await initializeAnalysisContext({
      services,
      options: combinedOptions,
    });
    let analysisResult = await performInitialAnalysis({
      controllers,
      context: analysisContext,
    });

    logger.debug(
      `Security enabled: ${config?.security?.enabled}, skipSecurity: ${combinedOptions.skipSecurity}`,
    );

    const skipSecurity = combinedOptions.skipSecurity ?? true;
    if (config?.security?.enabled && !skipSecurity) {
      const securityResult = await handleSecurityChecks({
        controllers,
        analysisResult,
      });
      controllers.securityController.displaySecuritySummary(securityResult);
    }

    reporter.generateReport({
      result: analysisResult,
      options: { detailed: combinedOptions.detailed ?? false },
    });

    if (services.isAIEnabled) {
      analysisResult = await processAIFeatures({
        controllers,
        analysisResult,
        options: combinedOptions,
        logger,
      });
    } else if (combinedOptions.createPR ?? combinedOptions.draft) {
      analysisResult = await handlePRCreation({
        controllers,
        options: combinedOptions,
        analysisResult,
        analysisContext,
      });
    }

    logger.debug("Branch analysis completed successfully");
    return analysisResult;
  } catch (error) {
    logger.error(`\n❌ Branch analysis failed:`, error);
    logger.debug("Full analysis error details:", error);
    throw error;
  }
}

async function initializeAnalysisContext({
  services,
  options,
}: InitializeAnalysisContextParams): Promise<AnalysisContext> {
  const currentBranch = await services.git.getCurrentBranch();
  const branchToAnalyze = options.name ?? currentBranch;
  const baseBranch = await services.git.getDefaultBranch();

  services.logger.debug("Branch analysis context:", {
    currentBranch,
    branchToAnalyze,
    baseBranch,
  });

  return { branchToAnalyze, baseBranch };
}

async function performInitialAnalysis({
  controllers,
  context,
}: InitialAnalysisParams): Promise<PRAnalysisResult> {
  if (context.branchToAnalyze === context.baseBranch) {
    throw new Error(
      `Cannot analyze the base branch (${context.baseBranch}). Please create and switch to a feature branch first.`,
    );
  }

  return controllers.analysisController.analyzeBranch({
    branchToAnalyze: context.branchToAnalyze,
    enableAI: false,
  });
}

async function handleSecurityChecks({
  controllers,
  analysisResult,
}: SecurityCheckParams): Promise<SecurityCheckResult> {
  const securityResult = controllers.securityController.analyzeSecurity({
    result: analysisResult,
  });

  if (
    securityResult.secretFindings.length > 0 ||
    securityResult.fileFindings.length > 0
  ) {
    await controllers.securityController.handleSecurityIssues({
      securityResult,
    });
  }

  return securityResult;
}

async function processAIFeatures({
  controllers,
  analysisResult,
  options,
  logger,
}: ProcessAIParams): Promise<PRAnalysisResult> {
  logger.debug("AI processing configuration:", {
    split: options.split,
    needsGitHubAccess: Boolean(options.createPR ?? options.draft),
  });

  const needsGitHubAccess = options.createPR ?? options.draft;
  let result = analysisResult;

  if (needsGitHubAccess) {
    const hasGitHubAccess =
      await controllers.prController.validateGitHubAccess();
    if (hasGitHubAccess) {
      result = await processAIWithGitHub({
        controllers,
        analysisResult: result,
        options,
      });
    } else {
      logger.warn(
        "⚠️  GitHub access required for PR creation but validation failed",
      );
    }
  } else {
    result = await processAIWithoutGitHub({
      controllers,
      analysisResult: result,
      options,
    });
  }

  return result;
}

async function processAIWithGitHub({
  controllers,
  analysisResult,
  options,
}: ProcessAIWithGitHubParams): Promise<PRAnalysisResult> {
  let result = analysisResult;

  if (options.split) {
    result = await controllers.aiController.handleSplitSuggestions({
      analysisResult: result,
    });

    if (result.splitSuggestion) {
      const splitResult =
        await controllers.splitController.handleSplitSuggestion({
          analysisResult: result,
        });

      if (splitResult.skipFurtherSuggestions) {
        return splitResult;
      }
    }
  }

  result = await controllers.aiController.handleAISuggestions({
    analysisResult: result,
  });

  return controllers.prController.createPullRequest({
    options,
    analysisResult: result,
    branchToAnalyze: result.branch,
  });
}

async function processAIWithoutGitHub({
  controllers,
  analysisResult,
  options,
}: ProcessAIWithGitHubParams): Promise<PRAnalysisResult> {
  let result = analysisResult;

  if (options.split) {
    result = await controllers.aiController.handleSplitSuggestions({
      analysisResult: result,
    });

    if (result.splitSuggestion) {
      const splitResult =
        await controllers.splitController.handleSplitSuggestion({
          analysisResult: result,
        });

      if (splitResult.skipFurtherSuggestions) {
        return splitResult;
      }
    }
  }

  if (result.skipFurtherSuggestions) {
    return result;
  }

  return controllers.aiController.handleAISuggestions({
    analysisResult: result,
  });
}

async function handlePRCreation({
  controllers,
  options,
  analysisResult,
  analysisContext,
}: HandlePRParams): Promise<PRAnalysisResult> {
  const hasGitHubAccess = await controllers.prController.validateGitHubAccess();
  if (hasGitHubAccess) {
    return controllers.prController.createPullRequest({
      options,
      analysisResult,
      branchToAnalyze: analysisContext.branchToAnalyze,
    });
  }
  return analysisResult;
}
