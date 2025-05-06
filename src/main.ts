// @ts-nocheck
import { Plugin, Notice, App, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Custom logger with levels
class Logger {
  static DEBUG = 0;
  static INFO = 1;
  static WARN = 2;
  static ERROR = 3;
  
  static level = Logger.DEBUG; // Set minimum log level
  static prefix = "EditNext";
  
  static debug(message: string, ...args: any[]) {
    if (Logger.level <= Logger.DEBUG) {
      console.debug(`[${Logger.prefix}] ${message}`, ...args);
    }
  }
  
  static info(message: string, ...args: any[]) {
    if (Logger.level <= Logger.INFO) {
      console.info(`[${Logger.prefix}] ${message}`, ...args);
    }
  }
  
  static warn(message: string, ...args: any[]) {
    if (Logger.level <= Logger.WARN) {
      console.warn(`[${Logger.prefix}] ${message}`, ...args);
    }
  }
  
  static error(message: string, ...args: any[]) {
    if (Logger.level <= Logger.ERROR) {
      console.error(`[${Logger.prefix}] ${message}`, ...args);
    }
  }
}

// --------------------------------------------------
// Settings definition
// --------------------------------------------------
interface EditNextPluginSettings {
  openaiApiKey: string;
  pythonPath: string;
  weights: [number, number, number];
  model: string;
  targetFolder: string; // relative to vault root
}

const DEFAULT_SETTINGS: EditNextPluginSettings = {
  openaiApiKey: '',
  pythonPath: 'python3',
  weights: [0.6, 0.2, 0.2],
  model: 'gpt-4o-mini',
  targetFolder: '',
};

// --------------------------------------------------
// Helper to run external python process
// --------------------------------------------------
async function runRanker(app: App, settings: EditNextPluginSettings): Promise<string> {
  return new Promise((resolve, reject) => {
    // Determine folder absolute path
    const vaultPath = app.vault.adapter.getBasePath();
    const targetDir = settings.targetFolder
      ? path.join(vaultPath, normalizePath(settings.targetFolder))
      : vaultPath;
    
    Logger.debug("Running ranker with settings:", settings);
    Logger.debug("Target directory:", targetDir);

    // Ensure directory exists
    if (!fs.existsSync(targetDir)) {
      const error = `Target directory not found: ${targetDir}`;
      Logger.error(error);
      reject(new Error(error));
      return;
    }

    // Compose command
    const scriptPath = path.join(__dirname, '..', '..', 'editnext', 'essay-quality-ranker.py');
    Logger.debug("Script path:", scriptPath);
    
    // Check if script exists
    if (!fs.existsSync(scriptPath)) {
      const error = `Script not found: ${scriptPath}`;
      Logger.error(error);
      reject(new Error(error));
      return;
    }
    
    const cmdArgs: string[] = [
      scriptPath,
      targetDir,
      '--weights',
      ...settings.weights.map((w) => w.toString()),
      '--model',
      settings.model,
    ];
    
    Logger.debug("Command:", settings.pythonPath, cmdArgs.join(' '));

    // Provide environment
    const env = { ...process.env, OPENAI_API_KEY: settings.openaiApiKey };
    Logger.debug("API key set:", !!settings.openaiApiKey);

    // Spawn child process
    try {
      const child = spawn(settings.pythonPath, cmdArgs, { env });

      let output = '';
      let errorOutput = '';
      
      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        Logger.debug(`Python stdout: ${chunk}`);
        output += chunk;
      });
      
      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        Logger.error(`Python stderr: ${chunk}`);
        errorOutput += chunk;
      });
      
      child.on('error', (err: Error) => {
        Logger.error("Process error:", err);
        reject(err);
      });
      
      child.on('close', (code: number) => {
        Logger.debug(`Process exited with code ${code}`);
        if (code === 0) {
          resolve(output);
        } else {
          const error = `Process exited with code ${code}${errorOutput ? ': ' + errorOutput : ''}`;
          Logger.error(error);
          reject(new Error(error));
        }
      });
    } catch (err) {
      Logger.error("Failed to spawn process:", err);
      reject(err);
    }
  });
}

// --------------------------------------------------
// Plugin implementation
// --------------------------------------------------
export default class EditNextPlugin extends Plugin {
  settings: EditNextPluginSettings = DEFAULT_SETTINGS;

  async onload() {
    Logger.info('Loading EditNext Ranker plugin');
    
    try {
      // Log plugin details
      Logger.debug("Plugin directory:", this.manifest.dir);
      Logger.debug("Plugin version:", this.manifest.version);
      
      await this.loadSettings();
      Logger.debug("Settings loaded:", this.settings);

      // Register command
      // @ts-ignore
      this.addCommand({
        id: 'editnext-rank-files',
        name: 'Rank files by editing effort',
        callback: async () => {
          Logger.info('Running EditNext ranker command...');
          new Notice('Running EditNext ranker...');
          try {
            const result = await runRanker(this.app, this.settings);
            Logger.debug("Ranker completed successfully");
            // Show output in a new pane
            // @ts-ignore
            const leaf = this.app.workspace.getLeaf(true);
            await leaf.open(new EditNextResultView(leaf, result));
          } catch (err) {
            const errorMsg = (err as Error).message;
            Logger.error("Ranker error:", err);
            new Notice(`EditNext error: ${errorMsg}`);
          }
        },
      });

      // Add settings tab
      // @ts-ignore
      this.addSettingTab(new EditNextSettingTab(this.app, this));
      
      Logger.info('EditNext Ranker plugin loaded successfully');
    } catch (err) {
      Logger.error("Error during plugin load:", err);
      throw err; // Re-throw to let Obsidian handle it
    }
  }

  onunload() {
    Logger.info('Unloading EditNext Ranker plugin');
  }

  async loadSettings() {
    try {
      const savedData = await this.loadData();
      Logger.debug("Loaded saved data:", savedData);
      this.settings = Object.assign({}, DEFAULT_SETTINGS, savedData);
    } catch (err) {
      Logger.error("Failed to load settings:", err);
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  async saveSettings() {
    try {
      await this.saveData(this.settings);
      Logger.debug("Settings saved successfully");
    } catch (err) {
      Logger.error("Failed to save settings:", err);
    }
  }
}

// --------------------------------------------------
// View to display results (simple markdown view)
// --------------------------------------------------
import { ItemView, WorkspaceLeaf } from 'obsidian';
const VIEW_TYPE = 'editnext-results';

class EditNextResultView extends ItemView {
  resultText: string;

  constructor(leaf: WorkspaceLeaf, text: string) {
    super(leaf);
    this.resultText = text;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'EditNext Results';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    const pre = container.createEl('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.setText(this.resultText);
  }

  async onClose() {}
}

// --------------------------------------------------
// Settings Tab UI
// --------------------------------------------------
class EditNextSettingTab extends PluginSettingTab {
  plugin: EditNextPlugin;

  constructor(app: App, plugin: EditNextPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    Logger.debug("Settings tab initialized");
  }

  display(): void {
    const { containerEl } = this;
    Logger.debug("Settings tab displayed");

    containerEl.empty();

    containerEl.createEl('h2', { text: 'EditNext Ranker Settings' });

    new Setting(containerEl)
      .setName('OpenAI API Key')
      .setDesc('Required to query GPT models')
      .addText((text) =>
        text
          .setPlaceholder('sk-XXXX')
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Python Path')
      .setDesc('Path to Python executable (with dependencies installed)')
      .addText((text) =>
        text
          .setPlaceholder('python3')
          .setValue(this.plugin.settings.pythonPath)
          .onChange(async (value) => {
            this.plugin.settings.pythonPath = value.trim() || 'python3';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Weights')
      .setDesc('Three numbers for LLM, Grammar, Readability weights (sum 1.0)')
      .addText((text) =>
        text
          .setPlaceholder('0.6 0.2 0.2')
          .setValue(this.plugin.settings.weights.join(' '))
          .onChange(async (value) => {
            const parts = value.split(/\s+/).map(Number);
            if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
              this.plugin.settings.weights = parts as [number, number, number];
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('OpenAI Model')
      .setDesc('Model to use for scoring')
      .addText((text) =>
        text.setPlaceholder('gpt-4o-mini').setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Target Folder')
      .setDesc('Relative path inside vault; leave blank for entire vault')
      .addText((text) =>
        text
          .setPlaceholder('drafts')
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
} 