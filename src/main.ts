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
  excludeFolders: string[];
}

const DEFAULT_SETTINGS: EditNextPluginSettings = {
  openaiApiKey: '',
  pythonPath: 'python3',
  weights: [0.6, 0.2, 0.2],
  model: 'gpt-4o-mini',
  targetFolder: '',
  excludeFolders: [],
};

// --------------------------------------------------
// Helper to run external python process
// --------------------------------------------------
async function runRanker(app: App, plugin: EditNextPlugin, settings: EditNextPluginSettings): Promise<any> {
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

    // Try multiple possible script locations
    const possibleScriptPaths = [
      // Try in plugin's data directory (relative to plugin location)
      path.join(plugin.manifest.dir, 'data', 'essay-quality-ranker.py'),
      // Try in the vault root
      path.join(vaultPath, 'essay-quality-ranker.py'),
      // Try in current execution directory
      path.join(process.cwd(), 'essay-quality-ranker.py'),
      // Try in parent directory
      path.join(process.cwd(), '..', 'essay-quality-ranker.py'),
      // Path relative to the vault (assuming plugin is installed in .obsidian/plugins)
      path.join(vaultPath, '.obsidian', 'plugins', 'editnext-plugin', 'data', 'essay-quality-ranker.py')
    ];
    
    let scriptPath = null;
    for (const tryPath of possibleScriptPaths) {
      Logger.debug(`Checking script path: ${tryPath}`);
      if (fs.existsSync(tryPath)) {
        scriptPath = tryPath;
        Logger.debug(`Found script at: ${scriptPath}`);
        break;
      }
    }
    
    // Check if script exists
    if (!scriptPath) {
      const error = `Script not found in any of the expected locations. Please place essay-quality-ranker.py in your plugin's data folder or vault root.`;
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
      '--json' // Always request JSON output
    ];
    
    // Include exclude folders if specified
    if (settings.excludeFolders && settings.excludeFolders.length > 0) {
      cmdArgs.push('--exclude-folders', ...settings.excludeFolders);
      Logger.debug('Excluding folders:', settings.excludeFolders);
    }
    
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
          try {
            // Try to parse the JSON output
            const results = JSON.parse(output);
            // Sort results by composite_score descending
            if (Array.isArray(results)) {
              (results as RankerResult[]).sort((a, b) => b.composite_score - a.composite_score);
            }
            resolve(results);
          } catch (e) {
            // Fallback to raw text if JSON parsing fails
            Logger.warn("Failed to parse JSON output, returning raw text:", e);
            resolve(output);
          }
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
  ribbonEl: HTMLElement | null = null;
  statusBarItem: HTMLElement | null = null;

  async onload() {
    Logger.info('Loading EditNext Ranker plugin');
    
    try {
      // Log plugin details
      Logger.debug("Plugin directory:", this.manifest.dir);
      Logger.debug("Plugin version:", this.manifest.version);
      
      await this.loadSettings();
      Logger.debug("Settings loaded:", this.settings);

      // Add ribbon icon
      this.ribbonEl = this.addRibbonIcon('file-edit', 'EditNext Ranker', async () => {
        this.runRankerCommand();
      });

      // Add status bar item (initially hidden)
      this.statusBarItem = this.addStatusBarItem();
      this.statusBarItem.addClass('editnext-status');
      this.statusBarItem.style.display = 'none';

      // Register command
      this.addCommand({
        id: 'editnext-rank-files',
        name: 'Rank files by editing effort',
        callback: async () => {
          this.runRankerCommand();
        },
      });
      
      // Add command to update frontmatter
      this.addCommand({
        id: 'editnext-update-frontmatter',
        name: 'Update current note with edit score',
        editorCallback: async (editor, view) => {
          await this.updateCurrentNoteFrontmatter(view);
        }
      });

      // Add settings tab
      this.addSettingTab(new EditNextSettingTab(this.app, this));
      
      Logger.info('EditNext Ranker plugin loaded successfully');
    } catch (err) {
      Logger.error("Error during plugin load:", err);
      throw err; // Re-throw to let Obsidian handle it
    }
  }

  onunload() {
    Logger.info('Unloading EditNext Ranker plugin');
    // Clear references
    this.ribbonEl = null;
    this.statusBarItem = null;
  }
  
  async runRankerCommand() {
    // Show persistent callout for processing
    const processingNotice = new Notice('⏳ Running EditNext ranker...', 0);
    // Show progress in status bar
    if (this.statusBarItem) {
      this.statusBarItem.setText('EditNext: Analyzing files...');
      this.statusBarItem.style.display = 'block';
    }
    
    try {
      const results = await runRanker(this.app, this, this.settings);
      // Hide status bar item
      if (this.statusBarItem) {
        this.statusBarItem.style.display = 'none';
      }
      // Hide processing callout on success
      processingNotice.hide();
      
      // Store results in plugin instance for later use
      if (Array.isArray(results)) {
        await this.updateAllFrontmatter(results);
      }
      
      // Show output in a new pane
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.open(new EditNextResultView(leaf, results));
      
      // Show success notice with top file info
      if (Array.isArray(results) && results.length > 0) {
        const topFile = results[0];
        const fileName = topFile.file.split(/[\/\\]/).pop();
        new Notice(`Top edit priority: ${fileName} (score: ${topFile.composite_score.toFixed(1)})`);
      }
    } catch (err) {
      // Hide status bar on error
      if (this.statusBarItem) {
        this.statusBarItem.style.display = 'none';
      }
      // Hide processing callout on error
      processingNotice.hide();
      
      const errorMsg = (err as Error).message;
      Logger.error("Ranker error:", err);
      new Notice(`EditNext error: ${errorMsg}`);
    }
  }
  
  async updateAllFrontmatter(results: RankerResult[]) {
    try {
      for (const result of results) {
        await this.updateFileFrontmatter(result);
      }
      Logger.info(`Updated frontmatter for ${results.length} files`);
    } catch (err) {
      Logger.error("Error updating frontmatter:", err);
    }
  }
  
  async updateFileFrontmatter(result: RankerResult) {
    try {
      // Find the file in the vault
      const files = this.app.vault.getFiles();
      
      // First try direct path match
      let targetFile = files.find(f => f.path === result.file);
      
      // If not found, try just the filename
      if (!targetFile) {
        const fileName = result.file.split(/[\/\\]/).pop();
        targetFile = files.find(f => f.name === fileName);
      }
      
      if (!targetFile) {
        Logger.warn(`File not found for frontmatter update: ${result.file}`);
        return;
      }
      
      // Read the file content
      const content = await this.app.vault.read(targetFile);
      
      // Update or add frontmatter
      const newContent = this.updateYamlFrontmatter(content, {
        edit_score: result.composite_score,
        llm_score: result.llm_score,
        grammar_score: result.grammar_score,
        readability_score: result.readability_score
      });
      
      // Write back if changed
      if (newContent !== content) {
        await this.app.vault.modify(targetFile, newContent);
        Logger.debug(`Updated frontmatter for ${targetFile.path}`);
      }
    } catch (err) {
      Logger.error(`Error updating frontmatter for ${result.file}:`, err);
    }
  }
  
  async updateCurrentNoteFrontmatter(view: any) {
    if (!view || !view.file) {
      new Notice("No active file");
      return;
    }
    
    try {
      // Get current file
      const file = view.file;
      
      // Run ranker just for this file
      const vaultPath = this.app.vault.adapter.getBasePath();
      const filePath = path.join(vaultPath, file.path);
      const dirPath = path.dirname(filePath);
      
      new Notice(`Analyzing ${file.name}...`);
      
      // Override target folder to only score this one file
      const originalFolder = this.settings.targetFolder;
      this.settings.targetFolder = path.relative(vaultPath, dirPath);
      
      // Run ranker
      const results = await runRanker(this.app, this, this.settings);
      
      // Restore original setting
      this.settings.targetFolder = originalFolder;
      
      if (Array.isArray(results) && results.length > 0) {
        // Find this file in results
        const result = results.find(r => {
          const resultName = r.file.split(/[\/\\]/).pop();
          return resultName === file.name;
        });
        
        if (result) {
          await this.updateFileFrontmatter(result);
          new Notice(`Updated edit scores for ${file.name}`);
        } else {
          new Notice(`Could not find analysis results for ${file.name}`);
        }
      } else {
        new Notice("No results returned from analysis");
      }
    } catch (err) {
      Logger.error("Error updating current note:", err);
      new Notice(`Error: ${(err as Error).message}`);
    }
  }
  
  updateYamlFrontmatter(content: string, data: Record<string, any>): string {
    // Regular expressions for frontmatter detection
    const yamlRegex = /^---\n([\s\S]*?)\n---\n/;
    const match = content.match(yamlRegex);
    
    if (match) {
      // Frontmatter exists, parse it
      try {
        const yamlContent = match[1];
        // Basic YAML parsing/manipulation without external dependencies
        let frontmatter = {};
        const lines = yamlContent.split('\n');
        for (const line of lines) {
          const keyValue = line.split(':');
          if (keyValue.length >= 2) {
            const key = keyValue[0].trim();
            const value = keyValue.slice(1).join(':').trim();
            if (key && value) {
              frontmatter[key] = value;
            }
          }
        }
        
        // Update with new data
        frontmatter = { ...frontmatter, ...data };
        
        // Serialize back to YAML
        let newYaml = '---\n';
        for (const [key, value] of Object.entries(frontmatter)) {
          // Format numbers nicely
          const formattedValue = typeof value === 'number' ? 
            Number.isInteger(value) ? value : value.toFixed(1) : 
            value;
          newYaml += `${key}: ${formattedValue}\n`;
        }
        newYaml += '---\n';
        
        // Replace old frontmatter
        return content.replace(yamlRegex, newYaml);
      } catch (e) {
        Logger.error("Error parsing frontmatter:", e);
        // If parsing fails, append new frontmatter properties
        let newYaml = match[0];
        for (const [key, value] of Object.entries(data)) {
          const formattedValue = typeof value === 'number' ? 
            Number.isInteger(value) ? value : value.toFixed(1) : 
            value;
          // Insert before the closing ---
          newYaml = newYaml.replace(/---\n$/, `${key}: ${formattedValue}\n---\n`);
        }
        return content.replace(yamlRegex, newYaml);
      }
    } else {
      // No frontmatter, add new one
      let newYaml = '---\n';
      for (const [key, value] of Object.entries(data)) {
        const formattedValue = typeof value === 'number' ? 
          Number.isInteger(value) ? value : value.toFixed(1) : 
          value;
        newYaml += `${key}: ${formattedValue}\n`;
      }
      newYaml += '---\n\n';
      return newYaml + content;
    }
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
// View to display results (interactive dashboard)
// --------------------------------------------------
import { ItemView, WorkspaceLeaf, TFile, MarkdownRenderer } from 'obsidian';
const VIEW_TYPE = 'editnext-results';

interface RankerResult {
  file: string;
  composite_score: number;
  llm_score: number;
  grammar_score: number;
  readability_score: number;
  notes: string;
}

class EditNextResultView extends ItemView {
  results: RankerResult[] | null = null;
  resultText: string = '';
  isJsonData: boolean = false;

  constructor(leaf: WorkspaceLeaf, data: any) {
    super(leaf);
    
    if (Array.isArray(data)) {
      this.results = data as RankerResult[];
      this.isJsonData = true;
    } else {
      // Fallback for plain text results
      this.resultText = String(data);
      this.isJsonData = false;
    }
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'EditNext Dashboard';
  }

  getIcon() {
    return 'file-edit';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('editnext-dashboard');
    
    // Add custom styles
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      .editnext-dashboard {
        padding: 20px;
      }
      .editnext-header {
        margin-bottom: 20px;
      }
      .editnext-table {
        width: 100%;
        border-collapse: collapse;
      }
      .editnext-table th {
        text-align: left;
        padding: 8px;
        border-bottom: 2px solid var(--background-modifier-border);
        font-weight: bold;
        cursor: pointer;
      }
      .editnext-table td {
        padding: 8px;
        border-bottom: 1px solid var(--background-modifier-border);
      }
      .editnext-file-link {
        cursor: pointer;
        color: var(--text-accent);
        text-decoration: none;
      }
      .editnext-file-link:hover {
        text-decoration: underline;
      }
      .editnext-row-high {
        background-color: rgba(255, 100, 100, 0.1);
      }
      .editnext-row-medium {
        background-color: rgba(255, 200, 0, 0.1);
      }
      .editnext-row-low {
        background-color: rgba(100, 255, 100, 0.1);
      }
      .editnext-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 0.8em;
        font-weight: bold;
      }
      .editnext-badge-high {
        background-color: rgba(255, 100, 100, 0.2);
        color: #d32f2f;
      }
      .editnext-badge-medium {
        background-color: rgba(255, 200, 0, 0.2);
        color: #f57c00;
      }
      .editnext-badge-low {
        background-color: rgba(100, 255, 100, 0.2);
        color: #388e3c;
      }
    `;
    container.prepend(styleEl);
    
    // Header
    const header = container.createEl('div', { cls: 'editnext-header' });
    header.createEl('h2', { text: 'EditNext Dashboard' });
    
    if (this.isJsonData && this.results) {
      this.renderInteractiveTable(container);
    } else {
      // Fallback to plain text display
      const pre = container.createEl('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.setText(this.resultText);
    }
  }
  
  async renderInteractiveTable(container: HTMLElement) {
    if (!this.results || this.results.length === 0) {
      container.createEl('p', { text: 'No results found.' });
      return;
    }
    
    // Create table
    const table = container.createEl('table', { cls: 'editnext-table' });
    
    // Table header
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    
    // Add headers with sort functionality
    const headers = [
      { key: 'file', text: 'File' },
      { key: 'composite_score', text: 'Score' },
      { key: 'llm_score', text: 'LLM' },
      { key: 'grammar_score', text: 'Grammar' },
      { key: 'readability_score', text: 'Readability' },
      { key: 'notes', text: 'Notes' }
    ];
    
    for (const header of headers) {
      const th = headerRow.createEl('th');
      th.setText(header.text);
      th.dataset.key = header.key;
      
      // Add click handler for sorting
      th.addEventListener('click', () => {
        this.sortResults(header.key);
        this.refreshTable(table);
      });
    }
    
    // Table body
    const tbody = table.createEl('tbody');
    this.populateTableRows(tbody);
  }
  
  populateTableRows(tbody: HTMLElement) {
    if (!this.results) return;
    
    tbody.empty();
    
    for (const result of this.results) {
      const row = tbody.createEl('tr');
      
      // Add row class based on score
      if (result.composite_score >= 70) {
        row.addClass('editnext-row-high');
      } else if (result.composite_score >= 40) {
        row.addClass('editnext-row-medium');
      } else {
        row.addClass('editnext-row-low');
      }
      
      // File cell with clickable link
      const fileCell = row.createEl('td');
      const fileLink = fileCell.createEl('a', { 
        cls: 'editnext-file-link',
        text: this.getFileName(result.file)
      });
      
      fileLink.addEventListener('click', async () => {
        await this.openFile(result.file);
      });
      
      // Score with colored badge
      const scoreCell = row.createEl('td');
      const scoreBadge = scoreCell.createEl('span', {
        cls: `editnext-badge ${this.getScoreClass(result.composite_score)}`,
        text: result.composite_score.toFixed(1)
      });
      
      // Other metrics
      row.createEl('td', { text: result.llm_score.toString() });
      row.createEl('td', { text: result.grammar_score.toFixed(1) });
      row.createEl('td', { text: result.readability_score.toFixed(1) });
      row.createEl('td', { text: result.notes });
    }
  }
  
  sortResults(key: string) {
    if (!this.results) return;
    
    const isNumeric = key !== 'file' && key !== 'notes';
    
    this.results.sort((a, b) => {
      if (isNumeric) {
        return b[key] - a[key]; // Descending for numeric
      } else {
        return String(a[key]).localeCompare(String(b[key])); // Ascending for text
      }
    });
  }
  
  refreshTable(table: HTMLElement) {
    const tbody = table.querySelector('tbody');
    if (tbody) {
      this.populateTableRows(tbody);
    }
  }
  
  getFileName(path: string): string {
    const parts = path.split(/[\/\\]/);
    return parts[parts.length - 1];
  }
  
  getScoreClass(score: number): string {
    if (score >= 70) return 'editnext-badge-high';
    if (score >= 40) return 'editnext-badge-medium';
    return 'editnext-badge-low';
  }
  
  async openFile(filePath: string) {
    try {
      // Find the file in the vault
      const files = this.app.vault.getFiles();
      let targetFile: TFile | null = null;
      
      // First try direct path match
      targetFile = files.find(f => f.path === filePath) || null;
      
      // If not found, try the filename
      if (!targetFile) {
        const fileName = this.getFileName(filePath);
        targetFile = files.find(f => f.name === fileName) || null;
      }
      
      if (targetFile) {
        // Open the file in a new leaf
        await this.app.workspace.getLeaf(false).openFile(targetFile);
      } else {
        new Notice(`File not found: ${filePath}`);
      }
    } catch (err) {
      Logger.error("Error opening file:", err);
      new Notice(`Error opening file: ${err.message}`);
    }
  }

  async onClose() {
    // Clean up
  }
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

    // Exclude subfolders setting
    new Setting(containerEl)
      .setName('Exclude Subfolders')
      .setDesc('Comma-separated list of subfolders (relative to vault) to exclude')
      .addText((text) =>
        text
          .setPlaceholder('drafts/old,archive')
          .setValue(this.plugin.settings.excludeFolders.join(','))
          .onChange(async (value) => {
            this.plugin.settings.excludeFolders = value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s);
            await this.plugin.saveSettings();
          })
      );
  }
} 