'use strict';

var obsidian = require('obsidian');
var fs = require('fs');
var path = require('path');
var child_process = require('child_process');

// @ts-nocheck
// Custom logger with levels
class Logger {
    static debug(message, ...args) {
        if (Logger.level <= Logger.DEBUG) {
            console.debug(`[${Logger.prefix}] ${message}`, ...args);
        }
    }
    static info(message, ...args) {
        if (Logger.level <= Logger.INFO) {
            console.info(`[${Logger.prefix}] ${message}`, ...args);
        }
    }
    static warn(message, ...args) {
        if (Logger.level <= Logger.WARN) {
            console.warn(`[${Logger.prefix}] ${message}`, ...args);
        }
    }
    static error(message, ...args) {
        if (Logger.level <= Logger.ERROR) {
            console.error(`[${Logger.prefix}] ${message}`, ...args);
        }
    }
}
Logger.DEBUG = 0;
Logger.INFO = 1;
Logger.WARN = 2;
Logger.ERROR = 3;
Logger.level = Logger.DEBUG; // Set minimum log level
Logger.prefix = "EditNext";
const DEFAULT_SETTINGS = {
    openaiApiKey: '',
    pythonPath: 'python3',
    weights: [0.6, 0.2, 0.2],
    model: 'gpt-4o-mini',
    targetFolder: '',
    excludeFolders: [],
    dashboardAsHomePage: false,
};
// --------------------------------------------------
// Helper to run external python process
// --------------------------------------------------
async function runRanker(app, plugin, settings) {
    return new Promise((resolve, reject) => {
        // Determine folder absolute path
        const vaultPath = app.vault.adapter.getBasePath();
        const targetDir = settings.targetFolder
            ? path.join(vaultPath, obsidian.normalizePath(settings.targetFolder))
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
        const cmdArgs = [
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
            cmdArgs.push('--exclude-folders');
            cmdArgs.push(...settings.excludeFolders);
            Logger.debug('Excluding folders:', settings.excludeFolders);
        }
        Logger.debug("Command:", settings.pythonPath, cmdArgs.join(' '));
        // Provide environment
        const env = { ...process.env, OPENAI_API_KEY: settings.openaiApiKey };
        Logger.debug("API key set:", !!settings.openaiApiKey);
        // Spawn child process
        try {
            const child = child_process.spawn(settings.pythonPath, cmdArgs, { env });
            let output = '';
            let errorOutput = '';
            child.stdout.on('data', (data) => {
                const chunk = data.toString();
                Logger.debug(`Python stdout: ${chunk}`);
                output += chunk;
            });
            child.stderr.on('data', (data) => {
                const chunk = data.toString();
                Logger.error(`Python stderr: ${chunk}`);
                errorOutput += chunk;
            });
            child.on('error', (err) => {
                Logger.error("Process error:", err);
                reject(err);
            });
            child.on('close', (code) => {
                Logger.debug(`Process exited with code ${code}`);
                if (code === 0) {
                    try {
                        // Try to parse the JSON output
                        const results = JSON.parse(output);
                        // Sort results by composite_score ascending (lowest first)
                        if (Array.isArray(results)) {
                            results.sort((a, b) => a.composite_score - b.composite_score);
                        }
                        resolve(results);
                    }
                    catch (e) {
                        // Fallback to raw text if JSON parsing fails
                        Logger.warn("Failed to parse JSON output, returning raw text:", e);
                        resolve(output);
                    }
                }
                else {
                    const error = `Process exited with code ${code}${errorOutput ? ': ' + errorOutput : ''}`;
                    Logger.error(error);
                    reject(new Error(error));
                }
            });
        }
        catch (err) {
            Logger.error("Failed to spawn process:", err);
            reject(err);
        }
    });
}
// --------------------------------------------------
// Plugin implementation
// --------------------------------------------------
class EditNextPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.settings = DEFAULT_SETTINGS;
        this.ribbonEl = null;
        this.statusBarItem = null;
        this.dashboardFilename = 'editnext-dashboard.md';
    }
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
            // Add command to open dashboard
            this.addCommand({
                id: 'editnext-open-dashboard',
                name: 'Open EditNext Dashboard',
                callback: async () => {
                    await this.openDashboard();
                },
            });
            // Add settings tab
            this.addSettingTab(new EditNextSettingTab(this.app, this));
            // Register for layout ready event to handle home page
            this.app.workspace.onLayoutReady(() => {
                if (this.settings.dashboardAsHomePage) {
                    // Try to open the markdown dashboard file
                    const dashboardFile = this.app.vault.getAbstractFileByPath(this.dashboardFilename);
                    if (dashboardFile) {
                        // Only open if no other leaves are open
                        if (this.app.workspace.getLeavesOfType('markdown').length === 0) {
                            const leaf = this.app.workspace.getLeaf('tab');
                            leaf.openFile(dashboardFile);
                        }
                    }
                    else {
                        // Fallback to generating new dashboard
                        if (this.app.workspace.getLeavesOfType('markdown').length === 0) {
                            this.openDashboard();
                        }
                    }
                }
            });
            Logger.info('EditNext Ranker plugin loaded successfully');
        }
        catch (err) {
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
        const processingNotice = new obsidian.Notice('⏳ Running EditNext ranker...', 0);
        // Show progress in status bar
        if (this.statusBarItem) {
            this.statusBarItem.setText('EditNext: Analyzing files...');
            this.statusBarItem.style.display = 'block';
        }
        try {
            await this.openDashboard();
            // Hide status bar item
            if (this.statusBarItem) {
                this.statusBarItem.style.display = 'none';
            }
            // Hide processing callout on success
            processingNotice.hide();
        }
        catch (err) {
            // Hide status bar on error
            if (this.statusBarItem) {
                this.statusBarItem.style.display = 'none';
            }
            // Hide processing callout on error
            processingNotice.hide();
            const errorMsg = err.message;
            Logger.error("Ranker error:", err);
            new obsidian.Notice(`EditNext error: ${errorMsg}`);
        }
    }
    async updateAllFrontmatter(results) {
        try {
            for (const result of results) {
                await this.updateFileFrontmatter(result);
            }
            Logger.info(`Updated frontmatter for ${results.length} files`);
        }
        catch (err) {
            Logger.error("Error updating frontmatter:", err);
        }
    }
    async updateFileFrontmatter(result) {
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
        }
        catch (err) {
            Logger.error(`Error updating frontmatter for ${result.file}:`, err);
        }
    }
    async updateCurrentNoteFrontmatter(view) {
        if (!view || !view.file) {
            new obsidian.Notice("No active file");
            return;
        }
        try {
            // Get current file
            const file = view.file;
            // Run ranker just for this file
            const vaultPath = this.app.vault.adapter.getBasePath();
            const filePath = path.join(vaultPath, file.path);
            const dirPath = path.dirname(filePath);
            new obsidian.Notice(`Analyzing ${file.name}...`);
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
                    new obsidian.Notice(`Updated edit scores for ${file.name}`);
                }
                else {
                    new obsidian.Notice(`Could not find analysis results for ${file.name}`);
                }
            }
            else {
                new obsidian.Notice("No results returned from analysis");
            }
        }
        catch (err) {
            Logger.error("Error updating current note:", err);
            new obsidian.Notice(`Error: ${err.message}`);
        }
    }
    updateYamlFrontmatter(content, data) {
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
            }
            catch (e) {
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
        }
        else {
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
            // Ensure excludeFolders is initialized as an array
            if (!Array.isArray(this.settings.excludeFolders)) {
                this.settings.excludeFolders = [];
                await this.saveSettings();
            }
        }
        catch (err) {
            Logger.error("Failed to load settings:", err);
            this.settings = { ...DEFAULT_SETTINGS };
        }
    }
    async saveSettings() {
        try {
            await this.saveData(this.settings);
            Logger.debug("Settings saved successfully");
        }
        catch (err) {
            Logger.error("Failed to save settings:", err);
        }
    }
    // Helper method to save dashboard as markdown
    async saveDashboardToMarkdown(results) {
        try {
            if (!results || results.length === 0) {
                return;
            }
            let content = '---\nalias: [EditNext Dashboard]\n---\n\n';
            content += '# 📝 EditNext Dashboard\n\n';
            content += '_Last updated: ' + new Date().toLocaleString() + '_\n\n';
            // Add table headers
            content += '| File | Score | LLM | Grammar | Readability | Notes |\n';
            content += '|------|-------|-----|---------|-------------|-------|\n';
            // Add table rows
            for (const result of results) {
                const fileName = result.file.split(/[\/\\]/).pop();
                const score = result.composite_score.toFixed(1);
                const llm = result.llm_score.toString();
                const grammar = result.grammar_score.toFixed(1);
                const readability = result.readability_score.toFixed(1);
                const notes = result.notes || '';
                // Create a wiki-link to the file
                const fileLink = `[[${fileName}]]`;
                content += `| ${fileLink} | ${score} | ${llm} | ${grammar} | ${readability} | ${notes} |\n`;
            }
            // Save the file
            const file = this.app.vault.getAbstractFileByPath(this.dashboardFilename);
            if (file) {
                await this.app.vault.modify(file, content);
            }
            else {
                await this.app.vault.create(this.dashboardFilename, content);
            }
            Logger.debug('Dashboard saved as markdown file');
        }
        catch (err) {
            Logger.error('Error saving dashboard to markdown:', err);
            throw err;
        }
    }
    // Helper method to open dashboard
    async openDashboard() {
        try {
            // Run the ranker to get fresh results
            const results = await runRanker(this.app, this, this.settings);
            // Update frontmatter if we have results
            if (Array.isArray(results)) {
                await this.updateAllFrontmatter(results);
                // Save dashboard as markdown
                await this.saveDashboardToMarkdown(results);
            }
            // Try to open the markdown file if it exists
            const dashboardFile = this.app.vault.getAbstractFileByPath(this.dashboardFilename);
            if (dashboardFile && this.settings.dashboardAsHomePage) {
                const leaf = this.app.workspace.getLeaf('tab');
                await leaf.openFile(dashboardFile);
            }
            else {
                // Fallback to the view if file doesn't exist or setting is disabled
                const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
                const leaf = existingLeaf || this.app.workspace.getLeaf('tab');
                await leaf.open(new EditNextResultView(leaf, results));
            }
        }
        catch (err) {
            Logger.error("Error opening dashboard:", err);
            new obsidian.Notice(`Error opening dashboard: ${err.message}`);
        }
    }
}
const VIEW_TYPE = 'editnext-results';
class EditNextResultView extends obsidian.ItemView {
    constructor(leaf, data) {
        super(leaf);
        this.results = null;
        this.resultText = '';
        this.isJsonData = false;
        if (Array.isArray(data)) {
            this.results = data;
            this.isJsonData = true;
        }
        else {
            // Fallback for plain text results
            this.resultText = String(data);
            this.isJsonData = false;
        }
    }
    getViewType() {
        return VIEW_TYPE;
    }
    getDisplayText() {
        return 'Grooming the garden';
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
        }
        else {
            // Fallback to plain text display
            const pre = container.createEl('pre');
            pre.style.whiteSpace = 'pre-wrap';
            pre.setText(this.resultText);
        }
    }
    async renderInteractiveTable(container) {
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
    populateTableRows(tbody) {
        if (!this.results)
            return;
        tbody.empty();
        for (const result of this.results) {
            const row = tbody.createEl('tr');
            // Add row class based on score
            if (result.composite_score >= 70) {
                row.addClass('editnext-row-high');
            }
            else if (result.composite_score >= 40) {
                row.addClass('editnext-row-medium');
            }
            else {
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
            scoreCell.createEl('span', {
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
    sortResults(key) {
        if (!this.results)
            return;
        const isNumeric = key !== 'file' && key !== 'notes';
        this.results.sort((a, b) => {
            if (isNumeric) {
                return b[key] - a[key]; // Descending for numeric
            }
            else {
                return String(a[key]).localeCompare(String(b[key])); // Ascending for text
            }
        });
    }
    refreshTable(table) {
        const tbody = table.querySelector('tbody');
        if (tbody) {
            this.populateTableRows(tbody);
        }
    }
    getFileName(path) {
        const parts = path.split(/[\/\\]/);
        return parts[parts.length - 1];
    }
    getScoreClass(score) {
        if (score >= 70)
            return 'editnext-badge-high';
        if (score >= 40)
            return 'editnext-badge-medium';
        return 'editnext-badge-low';
    }
    async openFile(filePath) {
        try {
            // Find the file in the vault
            const files = this.app.vault.getFiles();
            let targetFile = null;
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
            }
            else {
                new obsidian.Notice(`File not found: ${filePath}`);
            }
        }
        catch (err) {
            Logger.error("Error opening file:", err);
            new obsidian.Notice(`Error opening file: ${err.message}`);
        }
    }
    async onClose() {
        // Clean up
    }
}
// --------------------------------------------------
// Settings Tab UI
// --------------------------------------------------
class EditNextSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        Logger.debug("Settings tab initialized");
    }
    display() {
        const { containerEl } = this;
        Logger.debug("Settings tab displayed");
        containerEl.empty();
        containerEl.createEl('h2', { text: 'EditNext Ranker Settings' });
        new obsidian.Setting(containerEl)
            .setName('OpenAI API Key')
            .setDesc('Required to query GPT models')
            .addText((text) => text
            .setPlaceholder('sk-XXXX')
            .setValue(this.plugin.settings.openaiApiKey)
            .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value.trim();
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName('Python Path')
            .setDesc('Path to Python executable (with dependencies installed)')
            .addText((text) => text
            .setPlaceholder('python3')
            .setValue(this.plugin.settings.pythonPath)
            .onChange(async (value) => {
            this.plugin.settings.pythonPath = value.trim() || 'python3';
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName('Weights')
            .setDesc('Three numbers for LLM, Grammar, Readability weights (sum 1.0)')
            .addText((text) => text
            .setPlaceholder('0.6 0.2 0.2')
            .setValue(this.plugin.settings.weights.join(' '))
            .onChange(async (value) => {
            const parts = value.split(/\s+/).map(Number);
            if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
                this.plugin.settings.weights = parts;
                await this.plugin.saveSettings();
            }
        }));
        new obsidian.Setting(containerEl)
            .setName('OpenAI Model')
            .setDesc('Model to use for scoring')
            .addText((text) => text.setPlaceholder('gpt-4o-mini').setValue(this.plugin.settings.model).onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName('Target Folder')
            .setDesc('Relative path inside vault; leave blank for entire vault')
            .addText((text) => text
            .setPlaceholder('drafts')
            .setValue(this.plugin.settings.targetFolder)
            .onChange(async (value) => {
            this.plugin.settings.targetFolder = value.trim();
            await this.plugin.saveSettings();
        }));
        // Exclude subfolders setting
        new obsidian.Setting(containerEl)
            .setName('Exclude Subfolders')
            .setDesc('Comma-separated list of subfolders (relative to folder specified above) to exclude')
            .addText((text) => text
            .setPlaceholder('drafts/old,archive')
            .setValue(this.plugin.settings.excludeFolders.join(','))
            .onChange(async (value) => {
            Logger.debug('Setting exclude folders:', value);
            // Split by comma, trim whitespace, normalize paths, and filter empty strings
            this.plugin.settings.excludeFolders = value
                .split(',')
                .map((s) => obsidian.normalizePath(s.trim()))
                .filter((s) => s);
            Logger.debug('Parsed exclude folders:', this.plugin.settings.excludeFolders);
            await this.plugin.saveSettings();
        }));
        // Add dashboard as home page setting
        new obsidian.Setting(containerEl)
            .setName('Set Dashboard as Home Page')
            .setDesc('When enabled, the EditNext dashboard will be shown when opening Obsidian')
            .addToggle((toggle) => toggle
            .setValue(this.plugin.settings.dashboardAsHomePage)
            .onChange(async (value) => {
            this.plugin.settings.dashboardAsHomePage = value;
            await this.plugin.saveSettings();
        }));
    }
}

module.exports = EditNextPlugin;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLi4vc3JjL21haW4udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQHRzLW5vY2hlY2tcbmltcG9ydCB7IFBsdWdpbiwgTm90aWNlLCBBcHAsIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsIG5vcm1hbGl6ZVBhdGggfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgZnMgZnJvbSAnZnMnO1xuaW1wb3J0IHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBzcGF3biB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuXG4vLyBDdXN0b20gbG9nZ2VyIHdpdGggbGV2ZWxzXG5jbGFzcyBMb2dnZXIge1xuICBzdGF0aWMgREVCVUcgPSAwO1xuICBzdGF0aWMgSU5GTyA9IDE7XG4gIHN0YXRpYyBXQVJOID0gMjtcbiAgc3RhdGljIEVSUk9SID0gMztcbiAgXG4gIHN0YXRpYyBsZXZlbCA9IExvZ2dlci5ERUJVRzsgLy8gU2V0IG1pbmltdW0gbG9nIGxldmVsXG4gIHN0YXRpYyBwcmVmaXggPSBcIkVkaXROZXh0XCI7XG4gIFxuICBzdGF0aWMgZGVidWcobWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSkge1xuICAgIGlmIChMb2dnZXIubGV2ZWwgPD0gTG9nZ2VyLkRFQlVHKSB7XG4gICAgICBjb25zb2xlLmRlYnVnKGBbJHtMb2dnZXIucHJlZml4fV0gJHttZXNzYWdlfWAsIC4uLmFyZ3MpO1xuICAgIH1cbiAgfVxuICBcbiAgc3RhdGljIGluZm8obWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSkge1xuICAgIGlmIChMb2dnZXIubGV2ZWwgPD0gTG9nZ2VyLklORk8pIHtcbiAgICAgIGNvbnNvbGUuaW5mbyhgWyR7TG9nZ2VyLnByZWZpeH1dICR7bWVzc2FnZX1gLCAuLi5hcmdzKTtcbiAgICB9XG4gIH1cbiAgXG4gIHN0YXRpYyB3YXJuKG1lc3NhZ2U6IHN0cmluZywgLi4uYXJnczogYW55W10pIHtcbiAgICBpZiAoTG9nZ2VyLmxldmVsIDw9IExvZ2dlci5XQVJOKSB7XG4gICAgICBjb25zb2xlLndhcm4oYFske0xvZ2dlci5wcmVmaXh9XSAke21lc3NhZ2V9YCwgLi4uYXJncyk7XG4gICAgfVxuICB9XG4gIFxuICBzdGF0aWMgZXJyb3IobWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSkge1xuICAgIGlmIChMb2dnZXIubGV2ZWwgPD0gTG9nZ2VyLkVSUk9SKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGBbJHtMb2dnZXIucHJlZml4fV0gJHttZXNzYWdlfWAsIC4uLmFyZ3MpO1xuICAgIH1cbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU2V0dGluZ3MgZGVmaW5pdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmludGVyZmFjZSBFZGl0TmV4dFBsdWdpblNldHRpbmdzIHtcbiAgb3BlbmFpQXBpS2V5OiBzdHJpbmc7XG4gIHB5dGhvblBhdGg6IHN0cmluZztcbiAgd2VpZ2h0czogW251bWJlciwgbnVtYmVyLCBudW1iZXJdO1xuICBtb2RlbDogc3RyaW5nO1xuICB0YXJnZXRGb2xkZXI6IHN0cmluZzsgLy8gcmVsYXRpdmUgdG8gdmF1bHQgcm9vdFxuICBleGNsdWRlRm9sZGVyczogc3RyaW5nW107XG4gIGRhc2hib2FyZEFzSG9tZVBhZ2U6IGJvb2xlYW47IC8vIHdoZXRoZXIgdG8gc2hvdyBkYXNoYm9hcmQgYXMgaG9tZSBwYWdlXG59XG5cbmNvbnN0IERFRkFVTFRfU0VUVElOR1M6IEVkaXROZXh0UGx1Z2luU2V0dGluZ3MgPSB7XG4gIG9wZW5haUFwaUtleTogJycsXG4gIHB5dGhvblBhdGg6ICdweXRob24zJyxcbiAgd2VpZ2h0czogWzAuNiwgMC4yLCAwLjJdLFxuICBtb2RlbDogJ2dwdC00by1taW5pJyxcbiAgdGFyZ2V0Rm9sZGVyOiAnJyxcbiAgZXhjbHVkZUZvbGRlcnM6IFtdLFxuICBkYXNoYm9hcmRBc0hvbWVQYWdlOiBmYWxzZSxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBIZWxwZXIgdG8gcnVuIGV4dGVybmFsIHB5dGhvbiBwcm9jZXNzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gcnVuUmFua2VyKGFwcDogQXBwLCBwbHVnaW46IEVkaXROZXh0UGx1Z2luLCBzZXR0aW5nczogRWRpdE5leHRQbHVnaW5TZXR0aW5ncyk6IFByb21pc2U8YW55PiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgLy8gRGV0ZXJtaW5lIGZvbGRlciBhYnNvbHV0ZSBwYXRoXG4gICAgY29uc3QgdmF1bHRQYXRoID0gYXBwLnZhdWx0LmFkYXB0ZXIuZ2V0QmFzZVBhdGgoKTtcbiAgICBjb25zdCB0YXJnZXREaXIgPSBzZXR0aW5ncy50YXJnZXRGb2xkZXJcbiAgICAgID8gcGF0aC5qb2luKHZhdWx0UGF0aCwgbm9ybWFsaXplUGF0aChzZXR0aW5ncy50YXJnZXRGb2xkZXIpKVxuICAgICAgOiB2YXVsdFBhdGg7XG4gICAgXG4gICAgTG9nZ2VyLmRlYnVnKFwiUnVubmluZyByYW5rZXIgd2l0aCBzZXR0aW5nczpcIiwgc2V0dGluZ3MpO1xuICAgIExvZ2dlci5kZWJ1ZyhcIlRhcmdldCBkaXJlY3Rvcnk6XCIsIHRhcmdldERpcik7XG5cbiAgICAvLyBFbnN1cmUgZGlyZWN0b3J5IGV4aXN0c1xuICAgIGlmICghZnMuZXhpc3RzU3luYyh0YXJnZXREaXIpKSB7XG4gICAgICBjb25zdCBlcnJvciA9IGBUYXJnZXQgZGlyZWN0b3J5IG5vdCBmb3VuZDogJHt0YXJnZXREaXJ9YDtcbiAgICAgIExvZ2dlci5lcnJvcihlcnJvcik7XG4gICAgICByZWplY3QobmV3IEVycm9yKGVycm9yKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gVHJ5IG11bHRpcGxlIHBvc3NpYmxlIHNjcmlwdCBsb2NhdGlvbnNcbiAgICBjb25zdCBwb3NzaWJsZVNjcmlwdFBhdGhzID0gW1xuICAgICAgLy8gVHJ5IGluIHBsdWdpbidzIGRhdGEgZGlyZWN0b3J5IChyZWxhdGl2ZSB0byBwbHVnaW4gbG9jYXRpb24pXG4gICAgICBwYXRoLmpvaW4ocGx1Z2luLm1hbmlmZXN0LmRpciwgJ2RhdGEnLCAnZXNzYXktcXVhbGl0eS1yYW5rZXIucHknKSxcbiAgICAgIC8vIFRyeSBpbiB0aGUgdmF1bHQgcm9vdFxuICAgICAgcGF0aC5qb2luKHZhdWx0UGF0aCwgJ2Vzc2F5LXF1YWxpdHktcmFua2VyLnB5JyksXG4gICAgICAvLyBUcnkgaW4gY3VycmVudCBleGVjdXRpb24gZGlyZWN0b3J5XG4gICAgICBwYXRoLmpvaW4ocHJvY2Vzcy5jd2QoKSwgJ2Vzc2F5LXF1YWxpdHktcmFua2VyLnB5JyksXG4gICAgICAvLyBUcnkgaW4gcGFyZW50IGRpcmVjdG9yeVxuICAgICAgcGF0aC5qb2luKHByb2Nlc3MuY3dkKCksICcuLicsICdlc3NheS1xdWFsaXR5LXJhbmtlci5weScpLFxuICAgICAgLy8gUGF0aCByZWxhdGl2ZSB0byB0aGUgdmF1bHQgKGFzc3VtaW5nIHBsdWdpbiBpcyBpbnN0YWxsZWQgaW4gLm9ic2lkaWFuL3BsdWdpbnMpXG4gICAgICBwYXRoLmpvaW4odmF1bHRQYXRoLCAnLm9ic2lkaWFuJywgJ3BsdWdpbnMnLCAnZWRpdG5leHQtcGx1Z2luJywgJ2RhdGEnLCAnZXNzYXktcXVhbGl0eS1yYW5rZXIucHknKVxuICAgIF07XG4gICAgXG4gICAgbGV0IHNjcmlwdFBhdGggPSBudWxsO1xuICAgIGZvciAoY29uc3QgdHJ5UGF0aCBvZiBwb3NzaWJsZVNjcmlwdFBhdGhzKSB7XG4gICAgICBMb2dnZXIuZGVidWcoYENoZWNraW5nIHNjcmlwdCBwYXRoOiAke3RyeVBhdGh9YCk7XG4gICAgICBpZiAoZnMuZXhpc3RzU3luYyh0cnlQYXRoKSkge1xuICAgICAgICBzY3JpcHRQYXRoID0gdHJ5UGF0aDtcbiAgICAgICAgTG9nZ2VyLmRlYnVnKGBGb3VuZCBzY3JpcHQgYXQ6ICR7c2NyaXB0UGF0aH1gKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIFxuICAgIC8vIENoZWNrIGlmIHNjcmlwdCBleGlzdHNcbiAgICBpZiAoIXNjcmlwdFBhdGgpIHtcbiAgICAgIGNvbnN0IGVycm9yID0gYFNjcmlwdCBub3QgZm91bmQgaW4gYW55IG9mIHRoZSBleHBlY3RlZCBsb2NhdGlvbnMuIFBsZWFzZSBwbGFjZSBlc3NheS1xdWFsaXR5LXJhbmtlci5weSBpbiB5b3VyIHBsdWdpbidzIGRhdGEgZm9sZGVyIG9yIHZhdWx0IHJvb3QuYDtcbiAgICAgIExvZ2dlci5lcnJvcihlcnJvcik7XG4gICAgICByZWplY3QobmV3IEVycm9yKGVycm9yKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIFxuICAgIGNvbnN0IGNtZEFyZ3M6IHN0cmluZ1tdID0gW1xuICAgICAgc2NyaXB0UGF0aCxcbiAgICAgIHRhcmdldERpcixcbiAgICAgICctLXdlaWdodHMnLFxuICAgICAgLi4uc2V0dGluZ3Mud2VpZ2h0cy5tYXAoKHcpID0+IHcudG9TdHJpbmcoKSksXG4gICAgICAnLS1tb2RlbCcsXG4gICAgICBzZXR0aW5ncy5tb2RlbCxcbiAgICAgICctLWpzb24nIC8vIEFsd2F5cyByZXF1ZXN0IEpTT04gb3V0cHV0XG4gICAgXTtcbiAgICBcbiAgICAvLyBJbmNsdWRlIGV4Y2x1ZGUgZm9sZGVycyBpZiBzcGVjaWZpZWRcbiAgICBpZiAoc2V0dGluZ3MuZXhjbHVkZUZvbGRlcnMgJiYgc2V0dGluZ3MuZXhjbHVkZUZvbGRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgY21kQXJncy5wdXNoKCctLWV4Y2x1ZGUtZm9sZGVycycpO1xuICAgICAgY21kQXJncy5wdXNoKC4uLnNldHRpbmdzLmV4Y2x1ZGVGb2xkZXJzKTtcbiAgICAgIExvZ2dlci5kZWJ1ZygnRXhjbHVkaW5nIGZvbGRlcnM6Jywgc2V0dGluZ3MuZXhjbHVkZUZvbGRlcnMpO1xuICAgIH1cbiAgICBcbiAgICBMb2dnZXIuZGVidWcoXCJDb21tYW5kOlwiLCBzZXR0aW5ncy5weXRob25QYXRoLCBjbWRBcmdzLmpvaW4oJyAnKSk7XG5cbiAgICAvLyBQcm92aWRlIGVudmlyb25tZW50XG4gICAgY29uc3QgZW52ID0geyAuLi5wcm9jZXNzLmVudiwgT1BFTkFJX0FQSV9LRVk6IHNldHRpbmdzLm9wZW5haUFwaUtleSB9O1xuICAgIExvZ2dlci5kZWJ1ZyhcIkFQSSBrZXkgc2V0OlwiLCAhIXNldHRpbmdzLm9wZW5haUFwaUtleSk7XG5cbiAgICAvLyBTcGF3biBjaGlsZCBwcm9jZXNzXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNoaWxkID0gc3Bhd24oc2V0dGluZ3MucHl0aG9uUGF0aCwgY21kQXJncywgeyBlbnYgfSk7XG5cbiAgICAgIGxldCBvdXRwdXQgPSAnJztcbiAgICAgIGxldCBlcnJvck91dHB1dCA9ICcnO1xuICAgICAgXG4gICAgICBjaGlsZC5zdGRvdXQub24oJ2RhdGEnLCAoZGF0YTogQnVmZmVyKSA9PiB7XG4gICAgICAgIGNvbnN0IGNodW5rID0gZGF0YS50b1N0cmluZygpO1xuICAgICAgICBMb2dnZXIuZGVidWcoYFB5dGhvbiBzdGRvdXQ6ICR7Y2h1bmt9YCk7XG4gICAgICAgIG91dHB1dCArPSBjaHVuaztcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICBjaGlsZC5zdGRlcnIub24oJ2RhdGEnLCAoZGF0YTogQnVmZmVyKSA9PiB7XG4gICAgICAgIGNvbnN0IGNodW5rID0gZGF0YS50b1N0cmluZygpO1xuICAgICAgICBMb2dnZXIuZXJyb3IoYFB5dGhvbiBzdGRlcnI6ICR7Y2h1bmt9YCk7XG4gICAgICAgIGVycm9yT3V0cHV0ICs9IGNodW5rO1xuICAgICAgfSk7XG4gICAgICBcbiAgICAgIGNoaWxkLm9uKCdlcnJvcicsIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIExvZ2dlci5lcnJvcihcIlByb2Nlc3MgZXJyb3I6XCIsIGVycik7XG4gICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgfSk7XG4gICAgICBcbiAgICAgIGNoaWxkLm9uKCdjbG9zZScsIChjb2RlOiBudW1iZXIpID0+IHtcbiAgICAgICAgTG9nZ2VyLmRlYnVnKGBQcm9jZXNzIGV4aXRlZCB3aXRoIGNvZGUgJHtjb2RlfWApO1xuICAgICAgICBpZiAoY29kZSA9PT0gMCkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBUcnkgdG8gcGFyc2UgdGhlIEpTT04gb3V0cHV0XG4gICAgICAgICAgICBjb25zdCByZXN1bHRzID0gSlNPTi5wYXJzZShvdXRwdXQpO1xuICAgICAgICAgICAgLy8gU29ydCByZXN1bHRzIGJ5IGNvbXBvc2l0ZV9zY29yZSBhc2NlbmRpbmcgKGxvd2VzdCBmaXJzdClcbiAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlc3VsdHMpKSB7XG4gICAgICAgICAgICAgIChyZXN1bHRzIGFzIFJhbmtlclJlc3VsdFtdKS5zb3J0KChhLCBiKSA9PiBhLmNvbXBvc2l0ZV9zY29yZSAtIGIuY29tcG9zaXRlX3Njb3JlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc29sdmUocmVzdWx0cyk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gRmFsbGJhY2sgdG8gcmF3IHRleHQgaWYgSlNPTiBwYXJzaW5nIGZhaWxzXG4gICAgICAgICAgICBMb2dnZXIud2FybihcIkZhaWxlZCB0byBwYXJzZSBKU09OIG91dHB1dCwgcmV0dXJuaW5nIHJhdyB0ZXh0OlwiLCBlKTtcbiAgICAgICAgICAgIHJlc29sdmUob3V0cHV0KTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgZXJyb3IgPSBgUHJvY2VzcyBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX0ke2Vycm9yT3V0cHV0ID8gJzogJyArIGVycm9yT3V0cHV0IDogJyd9YDtcbiAgICAgICAgICBMb2dnZXIuZXJyb3IoZXJyb3IpO1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoZXJyb3IpKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJGYWlsZWQgdG8gc3Bhd24gcHJvY2VzczpcIiwgZXJyKTtcbiAgICAgIHJlamVjdChlcnIpO1xuICAgIH1cbiAgfSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQbHVnaW4gaW1wbGVtZW50YXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBFZGl0TmV4dFBsdWdpbiBleHRlbmRzIFBsdWdpbiB7XG4gIHNldHRpbmdzOiBFZGl0TmV4dFBsdWdpblNldHRpbmdzID0gREVGQVVMVF9TRVRUSU5HUztcbiAgcmliYm9uRWw6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIHN0YXR1c0Jhckl0ZW06IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIGRhc2hib2FyZEZpbGVuYW1lOiBzdHJpbmcgPSAnZWRpdG5leHQtZGFzaGJvYXJkLm1kJztcblxuICBhc3luYyBvbmxvYWQoKSB7XG4gICAgTG9nZ2VyLmluZm8oJ0xvYWRpbmcgRWRpdE5leHQgUmFua2VyIHBsdWdpbicpO1xuICAgIFxuICAgIHRyeSB7XG4gICAgICAvLyBMb2cgcGx1Z2luIGRldGFpbHNcbiAgICAgIExvZ2dlci5kZWJ1ZyhcIlBsdWdpbiBkaXJlY3Rvcnk6XCIsIHRoaXMubWFuaWZlc3QuZGlyKTtcbiAgICAgIExvZ2dlci5kZWJ1ZyhcIlBsdWdpbiB2ZXJzaW9uOlwiLCB0aGlzLm1hbmlmZXN0LnZlcnNpb24pO1xuICAgICAgXG4gICAgICBhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuICAgICAgTG9nZ2VyLmRlYnVnKFwiU2V0dGluZ3MgbG9hZGVkOlwiLCB0aGlzLnNldHRpbmdzKTtcblxuICAgICAgLy8gQWRkIHJpYmJvbiBpY29uXG4gICAgICB0aGlzLnJpYmJvbkVsID0gdGhpcy5hZGRSaWJib25JY29uKCdmaWxlLWVkaXQnLCAnRWRpdE5leHQgUmFua2VyJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICB0aGlzLnJ1blJhbmtlckNvbW1hbmQoKTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBBZGQgc3RhdHVzIGJhciBpdGVtIChpbml0aWFsbHkgaGlkZGVuKVxuICAgICAgdGhpcy5zdGF0dXNCYXJJdGVtID0gdGhpcy5hZGRTdGF0dXNCYXJJdGVtKCk7XG4gICAgICB0aGlzLnN0YXR1c0Jhckl0ZW0uYWRkQ2xhc3MoJ2VkaXRuZXh0LXN0YXR1cycpO1xuICAgICAgdGhpcy5zdGF0dXNCYXJJdGVtLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG5cbiAgICAgIC8vIFJlZ2lzdGVyIGNvbW1hbmRcbiAgICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICAgIGlkOiAnZWRpdG5leHQtcmFuay1maWxlcycsXG4gICAgICAgIG5hbWU6ICdSYW5rIGZpbGVzIGJ5IGVkaXRpbmcgZWZmb3J0JyxcbiAgICAgICAgY2FsbGJhY2s6IGFzeW5jICgpID0+IHtcbiAgICAgICAgICB0aGlzLnJ1blJhbmtlckNvbW1hbmQoKTtcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICAvLyBBZGQgY29tbWFuZCB0byB1cGRhdGUgZnJvbnRtYXR0ZXJcbiAgICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICAgIGlkOiAnZWRpdG5leHQtdXBkYXRlLWZyb250bWF0dGVyJyxcbiAgICAgICAgbmFtZTogJ1VwZGF0ZSBjdXJyZW50IG5vdGUgd2l0aCBlZGl0IHNjb3JlJyxcbiAgICAgICAgZWRpdG9yQ2FsbGJhY2s6IGFzeW5jIChlZGl0b3IsIHZpZXcpID0+IHtcbiAgICAgICAgICBhd2FpdCB0aGlzLnVwZGF0ZUN1cnJlbnROb3RlRnJvbnRtYXR0ZXIodmlldyk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICAvLyBBZGQgY29tbWFuZCB0byBvcGVuIGRhc2hib2FyZFxuICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgaWQ6ICdlZGl0bmV4dC1vcGVuLWRhc2hib2FyZCcsXG4gICAgICAgIG5hbWU6ICdPcGVuIEVkaXROZXh0IERhc2hib2FyZCcsXG4gICAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5vcGVuRGFzaGJvYXJkKCk7XG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgLy8gQWRkIHNldHRpbmdzIHRhYlxuICAgICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBFZGl0TmV4dFNldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgICAgLy8gUmVnaXN0ZXIgZm9yIGxheW91dCByZWFkeSBldmVudCB0byBoYW5kbGUgaG9tZSBwYWdlXG4gICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7XG4gICAgICAgIGlmICh0aGlzLnNldHRpbmdzLmRhc2hib2FyZEFzSG9tZVBhZ2UpIHtcbiAgICAgICAgICAvLyBUcnkgdG8gb3BlbiB0aGUgbWFya2Rvd24gZGFzaGJvYXJkIGZpbGVcbiAgICAgICAgICBjb25zdCBkYXNoYm9hcmRGaWxlID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRoaXMuZGFzaGJvYXJkRmlsZW5hbWUpO1xuICAgICAgICAgIGlmIChkYXNoYm9hcmRGaWxlKSB7XG4gICAgICAgICAgICAvLyBPbmx5IG9wZW4gaWYgbm8gb3RoZXIgbGVhdmVzIGFyZSBvcGVuXG4gICAgICAgICAgICBpZiAodGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZSgnbWFya2Rvd24nKS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgY29uc3QgbGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWFmKCd0YWInKTtcbiAgICAgICAgICAgICAgbGVhZi5vcGVuRmlsZShkYXNoYm9hcmRGaWxlIGFzIFRGaWxlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gRmFsbGJhY2sgdG8gZ2VuZXJhdGluZyBuZXcgZGFzaGJvYXJkXG4gICAgICAgICAgICBpZiAodGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZSgnbWFya2Rvd24nKS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgdGhpcy5vcGVuRGFzaGJvYXJkKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgTG9nZ2VyLmluZm8oJ0VkaXROZXh0IFJhbmtlciBwbHVnaW4gbG9hZGVkIHN1Y2Nlc3NmdWxseScpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgTG9nZ2VyLmVycm9yKFwiRXJyb3IgZHVyaW5nIHBsdWdpbiBsb2FkOlwiLCBlcnIpO1xuICAgICAgdGhyb3cgZXJyOyAvLyBSZS10aHJvdyB0byBsZXQgT2JzaWRpYW4gaGFuZGxlIGl0XG4gICAgfVxuICB9XG5cbiAgb251bmxvYWQoKSB7XG4gICAgTG9nZ2VyLmluZm8oJ1VubG9hZGluZyBFZGl0TmV4dCBSYW5rZXIgcGx1Z2luJyk7XG4gICAgLy8gQ2xlYXIgcmVmZXJlbmNlc1xuICAgIHRoaXMucmliYm9uRWwgPSBudWxsO1xuICAgIHRoaXMuc3RhdHVzQmFySXRlbSA9IG51bGw7XG4gIH1cbiAgXG4gIGFzeW5jIHJ1blJhbmtlckNvbW1hbmQoKSB7XG4gICAgLy8gU2hvdyBwZXJzaXN0ZW50IGNhbGxvdXQgZm9yIHByb2Nlc3NpbmdcbiAgICBjb25zdCBwcm9jZXNzaW5nTm90aWNlID0gbmV3IE5vdGljZSgn4o+zIFJ1bm5pbmcgRWRpdE5leHQgcmFua2VyLi4uJywgMCk7XG4gICAgLy8gU2hvdyBwcm9ncmVzcyBpbiBzdGF0dXMgYmFyXG4gICAgaWYgKHRoaXMuc3RhdHVzQmFySXRlbSkge1xuICAgICAgdGhpcy5zdGF0dXNCYXJJdGVtLnNldFRleHQoJ0VkaXROZXh0OiBBbmFseXppbmcgZmlsZXMuLi4nKTtcbiAgICAgIHRoaXMuc3RhdHVzQmFySXRlbS5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJztcbiAgICB9XG4gICAgXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMub3BlbkRhc2hib2FyZCgpO1xuICAgICAgXG4gICAgICAvLyBIaWRlIHN0YXR1cyBiYXIgaXRlbVxuICAgICAgaWYgKHRoaXMuc3RhdHVzQmFySXRlbSkge1xuICAgICAgICB0aGlzLnN0YXR1c0Jhckl0ZW0uc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgIH1cbiAgICAgIC8vIEhpZGUgcHJvY2Vzc2luZyBjYWxsb3V0IG9uIHN1Y2Nlc3NcbiAgICAgIHByb2Nlc3NpbmdOb3RpY2UuaGlkZSgpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgLy8gSGlkZSBzdGF0dXMgYmFyIG9uIGVycm9yXG4gICAgICBpZiAodGhpcy5zdGF0dXNCYXJJdGVtKSB7XG4gICAgICAgIHRoaXMuc3RhdHVzQmFySXRlbS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgICAgfVxuICAgICAgLy8gSGlkZSBwcm9jZXNzaW5nIGNhbGxvdXQgb24gZXJyb3JcbiAgICAgIHByb2Nlc3NpbmdOb3RpY2UuaGlkZSgpO1xuICAgICAgXG4gICAgICBjb25zdCBlcnJvck1zZyA9IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2U7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJSYW5rZXIgZXJyb3I6XCIsIGVycik7XG4gICAgICBuZXcgTm90aWNlKGBFZGl0TmV4dCBlcnJvcjogJHtlcnJvck1zZ31gKTtcbiAgICB9XG4gIH1cbiAgXG4gIGFzeW5jIHVwZGF0ZUFsbEZyb250bWF0dGVyKHJlc3VsdHM6IFJhbmtlclJlc3VsdFtdKSB7XG4gICAgdHJ5IHtcbiAgICAgIGZvciAoY29uc3QgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICAgICAgYXdhaXQgdGhpcy51cGRhdGVGaWxlRnJvbnRtYXR0ZXIocmVzdWx0KTtcbiAgICAgIH1cbiAgICAgIExvZ2dlci5pbmZvKGBVcGRhdGVkIGZyb250bWF0dGVyIGZvciAke3Jlc3VsdHMubGVuZ3RofSBmaWxlc2ApO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgTG9nZ2VyLmVycm9yKFwiRXJyb3IgdXBkYXRpbmcgZnJvbnRtYXR0ZXI6XCIsIGVycik7XG4gICAgfVxuICB9XG4gIFxuICBhc3luYyB1cGRhdGVGaWxlRnJvbnRtYXR0ZXIocmVzdWx0OiBSYW5rZXJSZXN1bHQpIHtcbiAgICB0cnkge1xuICAgICAgLy8gRmluZCB0aGUgZmlsZSBpbiB0aGUgdmF1bHRcbiAgICAgIGNvbnN0IGZpbGVzID0gdGhpcy5hcHAudmF1bHQuZ2V0RmlsZXMoKTtcbiAgICAgIFxuICAgICAgLy8gRmlyc3QgdHJ5IGRpcmVjdCBwYXRoIG1hdGNoXG4gICAgICBsZXQgdGFyZ2V0RmlsZSA9IGZpbGVzLmZpbmQoZiA9PiBmLnBhdGggPT09IHJlc3VsdC5maWxlKTtcbiAgICAgIFxuICAgICAgLy8gSWYgbm90IGZvdW5kLCB0cnkganVzdCB0aGUgZmlsZW5hbWVcbiAgICAgIGlmICghdGFyZ2V0RmlsZSkge1xuICAgICAgICBjb25zdCBmaWxlTmFtZSA9IHJlc3VsdC5maWxlLnNwbGl0KC9bXFwvXFxcXF0vKS5wb3AoKTtcbiAgICAgICAgdGFyZ2V0RmlsZSA9IGZpbGVzLmZpbmQoZiA9PiBmLm5hbWUgPT09IGZpbGVOYW1lKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgaWYgKCF0YXJnZXRGaWxlKSB7XG4gICAgICAgIExvZ2dlci53YXJuKGBGaWxlIG5vdCBmb3VuZCBmb3IgZnJvbnRtYXR0ZXIgdXBkYXRlOiAke3Jlc3VsdC5maWxlfWApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIFJlYWQgdGhlIGZpbGUgY29udGVudFxuICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlYWQodGFyZ2V0RmlsZSk7XG4gICAgICBcbiAgICAgIC8vIFVwZGF0ZSBvciBhZGQgZnJvbnRtYXR0ZXJcbiAgICAgIGNvbnN0IG5ld0NvbnRlbnQgPSB0aGlzLnVwZGF0ZVlhbWxGcm9udG1hdHRlcihjb250ZW50LCB7XG4gICAgICAgIGVkaXRfc2NvcmU6IHJlc3VsdC5jb21wb3NpdGVfc2NvcmUsXG4gICAgICAgIGxsbV9zY29yZTogcmVzdWx0LmxsbV9zY29yZSxcbiAgICAgICAgZ3JhbW1hcl9zY29yZTogcmVzdWx0LmdyYW1tYXJfc2NvcmUsXG4gICAgICAgIHJlYWRhYmlsaXR5X3Njb3JlOiByZXN1bHQucmVhZGFiaWxpdHlfc2NvcmVcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICAvLyBXcml0ZSBiYWNrIGlmIGNoYW5nZWRcbiAgICAgIGlmIChuZXdDb250ZW50ICE9PSBjb250ZW50KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeSh0YXJnZXRGaWxlLCBuZXdDb250ZW50KTtcbiAgICAgICAgTG9nZ2VyLmRlYnVnKGBVcGRhdGVkIGZyb250bWF0dGVyIGZvciAke3RhcmdldEZpbGUucGF0aH1gKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIExvZ2dlci5lcnJvcihgRXJyb3IgdXBkYXRpbmcgZnJvbnRtYXR0ZXIgZm9yICR7cmVzdWx0LmZpbGV9OmAsIGVycik7XG4gICAgfVxuICB9XG4gIFxuICBhc3luYyB1cGRhdGVDdXJyZW50Tm90ZUZyb250bWF0dGVyKHZpZXc6IGFueSkge1xuICAgIGlmICghdmlldyB8fCAhdmlldy5maWxlKSB7XG4gICAgICBuZXcgTm90aWNlKFwiTm8gYWN0aXZlIGZpbGVcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIFxuICAgIHRyeSB7XG4gICAgICAvLyBHZXQgY3VycmVudCBmaWxlXG4gICAgICBjb25zdCBmaWxlID0gdmlldy5maWxlO1xuICAgICAgXG4gICAgICAvLyBSdW4gcmFua2VyIGp1c3QgZm9yIHRoaXMgZmlsZVxuICAgICAgY29uc3QgdmF1bHRQYXRoID0gdGhpcy5hcHAudmF1bHQuYWRhcHRlci5nZXRCYXNlUGF0aCgpO1xuICAgICAgY29uc3QgZmlsZVBhdGggPSBwYXRoLmpvaW4odmF1bHRQYXRoLCBmaWxlLnBhdGgpO1xuICAgICAgY29uc3QgZGlyUGF0aCA9IHBhdGguZGlybmFtZShmaWxlUGF0aCk7XG4gICAgICBcbiAgICAgIG5ldyBOb3RpY2UoYEFuYWx5emluZyAke2ZpbGUubmFtZX0uLi5gKTtcbiAgICAgIFxuICAgICAgLy8gT3ZlcnJpZGUgdGFyZ2V0IGZvbGRlciB0byBvbmx5IHNjb3JlIHRoaXMgb25lIGZpbGVcbiAgICAgIGNvbnN0IG9yaWdpbmFsRm9sZGVyID0gdGhpcy5zZXR0aW5ncy50YXJnZXRGb2xkZXI7XG4gICAgICB0aGlzLnNldHRpbmdzLnRhcmdldEZvbGRlciA9IHBhdGgucmVsYXRpdmUodmF1bHRQYXRoLCBkaXJQYXRoKTtcbiAgICAgIFxuICAgICAgLy8gUnVuIHJhbmtlclxuICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IHJ1blJhbmtlcih0aGlzLmFwcCwgdGhpcywgdGhpcy5zZXR0aW5ncyk7XG4gICAgICBcbiAgICAgIC8vIFJlc3RvcmUgb3JpZ2luYWwgc2V0dGluZ1xuICAgICAgdGhpcy5zZXR0aW5ncy50YXJnZXRGb2xkZXIgPSBvcmlnaW5hbEZvbGRlcjtcbiAgICAgIFxuICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVzdWx0cykgJiYgcmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIC8vIEZpbmQgdGhpcyBmaWxlIGluIHJlc3VsdHNcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVzdWx0cy5maW5kKHIgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlc3VsdE5hbWUgPSByLmZpbGUuc3BsaXQoL1tcXC9cXFxcXS8pLnBvcCgpO1xuICAgICAgICAgIHJldHVybiByZXN1bHROYW1lID09PSBmaWxlLm5hbWU7XG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgIGF3YWl0IHRoaXMudXBkYXRlRmlsZUZyb250bWF0dGVyKHJlc3VsdCk7XG4gICAgICAgICAgbmV3IE5vdGljZShgVXBkYXRlZCBlZGl0IHNjb3JlcyBmb3IgJHtmaWxlLm5hbWV9YCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbmV3IE5vdGljZShgQ291bGQgbm90IGZpbmQgYW5hbHlzaXMgcmVzdWx0cyBmb3IgJHtmaWxlLm5hbWV9YCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG5ldyBOb3RpY2UoXCJObyByZXN1bHRzIHJldHVybmVkIGZyb20gYW5hbHlzaXNcIik7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJFcnJvciB1cGRhdGluZyBjdXJyZW50IG5vdGU6XCIsIGVycik7XG4gICAgICBuZXcgTm90aWNlKGBFcnJvcjogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuICBcbiAgdXBkYXRlWWFtbEZyb250bWF0dGVyKGNvbnRlbnQ6IHN0cmluZywgZGF0YTogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gICAgLy8gUmVndWxhciBleHByZXNzaW9ucyBmb3IgZnJvbnRtYXR0ZXIgZGV0ZWN0aW9uXG4gICAgY29uc3QgeWFtbFJlZ2V4ID0gL14tLS1cXG4oW1xcc1xcU10qPylcXG4tLS1cXG4vO1xuICAgIGNvbnN0IG1hdGNoID0gY29udGVudC5tYXRjaCh5YW1sUmVnZXgpO1xuICAgIFxuICAgIGlmIChtYXRjaCkge1xuICAgICAgLy8gRnJvbnRtYXR0ZXIgZXhpc3RzLCBwYXJzZSBpdFxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeWFtbENvbnRlbnQgPSBtYXRjaFsxXTtcbiAgICAgICAgLy8gQmFzaWMgWUFNTCBwYXJzaW5nL21hbmlwdWxhdGlvbiB3aXRob3V0IGV4dGVybmFsIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZnJvbnRtYXR0ZXIgPSB7fTtcbiAgICAgICAgY29uc3QgbGluZXMgPSB5YW1sQ29udGVudC5zcGxpdCgnXFxuJyk7XG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgICAgIGNvbnN0IGtleVZhbHVlID0gbGluZS5zcGxpdCgnOicpO1xuICAgICAgICAgIGlmIChrZXlWYWx1ZS5sZW5ndGggPj0gMikge1xuICAgICAgICAgICAgY29uc3Qga2V5ID0ga2V5VmFsdWVbMF0udHJpbSgpO1xuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBrZXlWYWx1ZS5zbGljZSgxKS5qb2luKCc6JykudHJpbSgpO1xuICAgICAgICAgICAgaWYgKGtleSAmJiB2YWx1ZSkge1xuICAgICAgICAgICAgICBmcm9udG1hdHRlcltrZXldID0gdmFsdWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyBVcGRhdGUgd2l0aCBuZXcgZGF0YVxuICAgICAgICBmcm9udG1hdHRlciA9IHsgLi4uZnJvbnRtYXR0ZXIsIC4uLmRhdGEgfTtcbiAgICAgICAgXG4gICAgICAgIC8vIFNlcmlhbGl6ZSBiYWNrIHRvIFlBTUxcbiAgICAgICAgbGV0IG5ld1lhbWwgPSAnLS0tXFxuJztcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoZnJvbnRtYXR0ZXIpKSB7XG4gICAgICAgICAgLy8gRm9ybWF0IG51bWJlcnMgbmljZWx5XG4gICAgICAgICAgY29uc3QgZm9ybWF0dGVkVmFsdWUgPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInID8gXG4gICAgICAgICAgICBOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSA/IHZhbHVlIDogdmFsdWUudG9GaXhlZCgxKSA6IFxuICAgICAgICAgICAgdmFsdWU7XG4gICAgICAgICAgbmV3WWFtbCArPSBgJHtrZXl9OiAke2Zvcm1hdHRlZFZhbHVlfVxcbmA7XG4gICAgICAgIH1cbiAgICAgICAgbmV3WWFtbCArPSAnLS0tXFxuJztcbiAgICAgICAgXG4gICAgICAgIC8vIFJlcGxhY2Ugb2xkIGZyb250bWF0dGVyXG4gICAgICAgIHJldHVybiBjb250ZW50LnJlcGxhY2UoeWFtbFJlZ2V4LCBuZXdZYW1sKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgTG9nZ2VyLmVycm9yKFwiRXJyb3IgcGFyc2luZyBmcm9udG1hdHRlcjpcIiwgZSk7XG4gICAgICAgIC8vIElmIHBhcnNpbmcgZmFpbHMsIGFwcGVuZCBuZXcgZnJvbnRtYXR0ZXIgcHJvcGVydGllc1xuICAgICAgICBsZXQgbmV3WWFtbCA9IG1hdGNoWzBdO1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhkYXRhKSkge1xuICAgICAgICAgIGNvbnN0IGZvcm1hdHRlZFZhbHVlID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyA/IFxuICAgICAgICAgICAgTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgPyB2YWx1ZSA6IHZhbHVlLnRvRml4ZWQoMSkgOiBcbiAgICAgICAgICAgIHZhbHVlO1xuICAgICAgICAgIC8vIEluc2VydCBiZWZvcmUgdGhlIGNsb3NpbmcgLS0tXG4gICAgICAgICAgbmV3WWFtbCA9IG5ld1lhbWwucmVwbGFjZSgvLS0tXFxuJC8sIGAke2tleX06ICR7Zm9ybWF0dGVkVmFsdWV9XFxuLS0tXFxuYCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGNvbnRlbnQucmVwbGFjZSh5YW1sUmVnZXgsIG5ld1lhbWwpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBObyBmcm9udG1hdHRlciwgYWRkIG5ldyBvbmVcbiAgICAgIGxldCBuZXdZYW1sID0gJy0tLVxcbic7XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhkYXRhKSkge1xuICAgICAgICBjb25zdCBmb3JtYXR0ZWRWYWx1ZSA9IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgPyBcbiAgICAgICAgICBOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSA/IHZhbHVlIDogdmFsdWUudG9GaXhlZCgxKSA6IFxuICAgICAgICAgIHZhbHVlO1xuICAgICAgICBuZXdZYW1sICs9IGAke2tleX06ICR7Zm9ybWF0dGVkVmFsdWV9XFxuYDtcbiAgICAgIH1cbiAgICAgIG5ld1lhbWwgKz0gJy0tLVxcblxcbic7XG4gICAgICByZXR1cm4gbmV3WWFtbCArIGNvbnRlbnQ7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgbG9hZFNldHRpbmdzKCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzYXZlZERhdGEgPSBhd2FpdCB0aGlzLmxvYWREYXRhKCk7XG4gICAgICBMb2dnZXIuZGVidWcoXCJMb2FkZWQgc2F2ZWQgZGF0YTpcIiwgc2F2ZWREYXRhKTtcbiAgICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBzYXZlZERhdGEpO1xuICAgICAgXG4gICAgICAvLyBFbnN1cmUgZXhjbHVkZUZvbGRlcnMgaXMgaW5pdGlhbGl6ZWQgYXMgYW4gYXJyYXlcbiAgICAgIGlmICghQXJyYXkuaXNBcnJheSh0aGlzLnNldHRpbmdzLmV4Y2x1ZGVGb2xkZXJzKSkge1xuICAgICAgICB0aGlzLnNldHRpbmdzLmV4Y2x1ZGVGb2xkZXJzID0gW107XG4gICAgICAgIGF3YWl0IHRoaXMuc2F2ZVNldHRpbmdzKCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJGYWlsZWQgdG8gbG9hZCBzZXR0aW5nczpcIiwgZXJyKTtcbiAgICAgIHRoaXMuc2V0dGluZ3MgPSB7IC4uLkRFRkFVTFRfU0VUVElOR1MgfTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBzYXZlU2V0dGluZ3MoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gICAgICBMb2dnZXIuZGVidWcoXCJTZXR0aW5ncyBzYXZlZCBzdWNjZXNzZnVsbHlcIik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJGYWlsZWQgdG8gc2F2ZSBzZXR0aW5nczpcIiwgZXJyKTtcbiAgICB9XG4gIH1cblxuICAvLyBIZWxwZXIgbWV0aG9kIHRvIHNhdmUgZGFzaGJvYXJkIGFzIG1hcmtkb3duXG4gIGFzeW5jIHNhdmVEYXNoYm9hcmRUb01hcmtkb3duKHJlc3VsdHM6IFJhbmtlclJlc3VsdFtdKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghcmVzdWx0cyB8fCByZXN1bHRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGxldCBjb250ZW50ID0gJy0tLVxcbmFsaWFzOiBbRWRpdE5leHQgRGFzaGJvYXJkXVxcbi0tLVxcblxcbic7XG4gICAgICBjb250ZW50ICs9ICcjIPCfk50gRWRpdE5leHQgRGFzaGJvYXJkXFxuXFxuJztcbiAgICAgIGNvbnRlbnQgKz0gJ19MYXN0IHVwZGF0ZWQ6ICcgKyBuZXcgRGF0ZSgpLnRvTG9jYWxlU3RyaW5nKCkgKyAnX1xcblxcbic7XG4gICAgICBcbiAgICAgIC8vIEFkZCB0YWJsZSBoZWFkZXJzXG4gICAgICBjb250ZW50ICs9ICd8IEZpbGUgfCBTY29yZSB8IExMTSB8IEdyYW1tYXIgfCBSZWFkYWJpbGl0eSB8IE5vdGVzIHxcXG4nO1xuICAgICAgY29udGVudCArPSAnfC0tLS0tLXwtLS0tLS0tfC0tLS0tfC0tLS0tLS0tLXwtLS0tLS0tLS0tLS0tfC0tLS0tLS18XFxuJztcbiAgICAgIFxuICAgICAgLy8gQWRkIHRhYmxlIHJvd3NcbiAgICAgIGZvciAoY29uc3QgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICAgICAgY29uc3QgZmlsZU5hbWUgPSByZXN1bHQuZmlsZS5zcGxpdCgvW1xcL1xcXFxdLykucG9wKCk7XG4gICAgICAgIGNvbnN0IHNjb3JlID0gcmVzdWx0LmNvbXBvc2l0ZV9zY29yZS50b0ZpeGVkKDEpO1xuICAgICAgICBjb25zdCBsbG0gPSByZXN1bHQubGxtX3Njb3JlLnRvU3RyaW5nKCk7XG4gICAgICAgIGNvbnN0IGdyYW1tYXIgPSByZXN1bHQuZ3JhbW1hcl9zY29yZS50b0ZpeGVkKDEpO1xuICAgICAgICBjb25zdCByZWFkYWJpbGl0eSA9IHJlc3VsdC5yZWFkYWJpbGl0eV9zY29yZS50b0ZpeGVkKDEpO1xuICAgICAgICBjb25zdCBub3RlcyA9IHJlc3VsdC5ub3RlcyB8fCAnJztcbiAgICAgICAgXG4gICAgICAgIC8vIENyZWF0ZSBhIHdpa2ktbGluayB0byB0aGUgZmlsZVxuICAgICAgICBjb25zdCBmaWxlTGluayA9IGBbWyR7ZmlsZU5hbWV9XV1gO1xuICAgICAgICBcbiAgICAgICAgY29udGVudCArPSBgfCAke2ZpbGVMaW5rfSB8ICR7c2NvcmV9IHwgJHtsbG19IHwgJHtncmFtbWFyfSB8ICR7cmVhZGFiaWxpdHl9IHwgJHtub3Rlc30gfFxcbmA7XG4gICAgICB9XG5cbiAgICAgIC8vIFNhdmUgdGhlIGZpbGVcbiAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGhpcy5kYXNoYm9hcmRGaWxlbmFtZSk7XG4gICAgICBpZiAoZmlsZSkge1xuICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkoZmlsZSwgY29udGVudCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5jcmVhdGUodGhpcy5kYXNoYm9hcmRGaWxlbmFtZSwgY29udGVudCk7XG4gICAgICB9XG5cbiAgICAgIExvZ2dlci5kZWJ1ZygnRGFzaGJvYXJkIHNhdmVkIGFzIG1hcmtkb3duIGZpbGUnKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIExvZ2dlci5lcnJvcignRXJyb3Igc2F2aW5nIGRhc2hib2FyZCB0byBtYXJrZG93bjonLCBlcnIpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgfVxuXG4gIC8vIEhlbHBlciBtZXRob2QgdG8gb3BlbiBkYXNoYm9hcmRcbiAgYXN5bmMgb3BlbkRhc2hib2FyZCgpIHtcbiAgICB0cnkge1xuICAgICAgLy8gUnVuIHRoZSByYW5rZXIgdG8gZ2V0IGZyZXNoIHJlc3VsdHNcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBydW5SYW5rZXIodGhpcy5hcHAsIHRoaXMsIHRoaXMuc2V0dGluZ3MpO1xuICAgICAgXG4gICAgICAvLyBVcGRhdGUgZnJvbnRtYXR0ZXIgaWYgd2UgaGF2ZSByZXN1bHRzXG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShyZXN1bHRzKSkge1xuICAgICAgICBhd2FpdCB0aGlzLnVwZGF0ZUFsbEZyb250bWF0dGVyKHJlc3VsdHMpO1xuICAgICAgICAvLyBTYXZlIGRhc2hib2FyZCBhcyBtYXJrZG93blxuICAgICAgICBhd2FpdCB0aGlzLnNhdmVEYXNoYm9hcmRUb01hcmtkb3duKHJlc3VsdHMpO1xuICAgICAgfVxuICAgICAgXG4gICAgICAvLyBUcnkgdG8gb3BlbiB0aGUgbWFya2Rvd24gZmlsZSBpZiBpdCBleGlzdHNcbiAgICAgIGNvbnN0IGRhc2hib2FyZEZpbGUgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGhpcy5kYXNoYm9hcmRGaWxlbmFtZSk7XG4gICAgICBpZiAoZGFzaGJvYXJkRmlsZSAmJiB0aGlzLnNldHRpbmdzLmRhc2hib2FyZEFzSG9tZVBhZ2UpIHtcbiAgICAgICAgY29uc3QgbGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWFmKCd0YWInKTtcbiAgICAgICAgYXdhaXQgbGVhZi5vcGVuRmlsZShkYXNoYm9hcmRGaWxlIGFzIFRGaWxlKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEZhbGxiYWNrIHRvIHRoZSB2aWV3IGlmIGZpbGUgZG9lc24ndCBleGlzdCBvciBzZXR0aW5nIGlzIGRpc2FibGVkXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nTGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFKVswXTtcbiAgICAgICAgY29uc3QgbGVhZiA9IGV4aXN0aW5nTGVhZiB8fCB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhZigndGFiJyk7XG4gICAgICAgIGF3YWl0IGxlYWYub3BlbihuZXcgRWRpdE5leHRSZXN1bHRWaWV3KGxlYWYsIHJlc3VsdHMpKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIExvZ2dlci5lcnJvcihcIkVycm9yIG9wZW5pbmcgZGFzaGJvYXJkOlwiLCBlcnIpO1xuICAgICAgbmV3IE5vdGljZShgRXJyb3Igb3BlbmluZyBkYXNoYm9hcmQ6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFZpZXcgdG8gZGlzcGxheSByZXN1bHRzIChpbnRlcmFjdGl2ZSBkYXNoYm9hcmQpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuaW1wb3J0IHsgSXRlbVZpZXcsIFdvcmtzcGFjZUxlYWYsIFRGaWxlLCBNYXJrZG93blJlbmRlcmVyIH0gZnJvbSAnb2JzaWRpYW4nO1xuY29uc3QgVklFV19UWVBFID0gJ2VkaXRuZXh0LXJlc3VsdHMnO1xuXG5pbnRlcmZhY2UgUmFua2VyUmVzdWx0IHtcbiAgZmlsZTogc3RyaW5nO1xuICBjb21wb3NpdGVfc2NvcmU6IG51bWJlcjtcbiAgbGxtX3Njb3JlOiBudW1iZXI7XG4gIGdyYW1tYXJfc2NvcmU6IG51bWJlcjtcbiAgcmVhZGFiaWxpdHlfc2NvcmU6IG51bWJlcjtcbiAgbm90ZXM6IHN0cmluZztcbn1cblxuY2xhc3MgRWRpdE5leHRSZXN1bHRWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICByZXN1bHRzOiBSYW5rZXJSZXN1bHRbXSB8IG51bGwgPSBudWxsO1xuICByZXN1bHRUZXh0OiBzdHJpbmcgPSAnJztcbiAgaXNKc29uRGF0YTogYm9vbGVhbiA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKGxlYWY6IFdvcmtzcGFjZUxlYWYsIGRhdGE6IGFueSkge1xuICAgIHN1cGVyKGxlYWYpO1xuICAgIFxuICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICB0aGlzLnJlc3VsdHMgPSBkYXRhIGFzIFJhbmtlclJlc3VsdFtdO1xuICAgICAgdGhpcy5pc0pzb25EYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRmFsbGJhY2sgZm9yIHBsYWluIHRleHQgcmVzdWx0c1xuICAgICAgdGhpcy5yZXN1bHRUZXh0ID0gU3RyaW5nKGRhdGEpO1xuICAgICAgdGhpcy5pc0pzb25EYXRhID0gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgZ2V0Vmlld1R5cGUoKSB7XG4gICAgcmV0dXJuIFZJRVdfVFlQRTtcbiAgfVxuXG4gIGdldERpc3BsYXlUZXh0KCkge1xuICAgIHJldHVybiAnR3Jvb21pbmcgdGhlIGdhcmRlbic7XG4gIH1cblxuICBnZXRJY29uKCkge1xuICAgIHJldHVybiAnZmlsZS1lZGl0JztcbiAgfVxuXG4gIGFzeW5jIG9uT3BlbigpIHtcbiAgICBjb25zdCBjb250YWluZXIgPSB0aGlzLmNvbnRhaW5lckVsLmNoaWxkcmVuWzFdO1xuICAgIGNvbnRhaW5lci5lbXB0eSgpO1xuICAgIGNvbnRhaW5lci5hZGRDbGFzcygnZWRpdG5leHQtZGFzaGJvYXJkJyk7XG4gICAgXG4gICAgLy8gQWRkIGN1c3RvbSBzdHlsZXNcbiAgICBjb25zdCBzdHlsZUVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3R5bGUnKTtcbiAgICBzdHlsZUVsLnRleHRDb250ZW50ID0gYFxuICAgICAgLmVkaXRuZXh0LWRhc2hib2FyZCB7XG4gICAgICAgIHBhZGRpbmc6IDIwcHg7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtaGVhZGVyIHtcbiAgICAgICAgbWFyZ2luLWJvdHRvbTogMjBweDtcbiAgICAgIH1cbiAgICAgIC5lZGl0bmV4dC10YWJsZSB7XG4gICAgICAgIHdpZHRoOiAxMDAlO1xuICAgICAgICBib3JkZXItY29sbGFwc2U6IGNvbGxhcHNlO1xuICAgICAgfVxuICAgICAgLmVkaXRuZXh0LXRhYmxlIHRoIHtcbiAgICAgICAgdGV4dC1hbGlnbjogbGVmdDtcbiAgICAgICAgcGFkZGluZzogOHB4O1xuICAgICAgICBib3JkZXItYm90dG9tOiAycHggc29saWQgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpO1xuICAgICAgICBmb250LXdlaWdodDogYm9sZDtcbiAgICAgICAgY3Vyc29yOiBwb2ludGVyO1xuICAgICAgfVxuICAgICAgLmVkaXRuZXh0LXRhYmxlIHRkIHtcbiAgICAgICAgcGFkZGluZzogOHB4O1xuICAgICAgICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpO1xuICAgICAgfVxuICAgICAgLmVkaXRuZXh0LWZpbGUtbGluayB7XG4gICAgICAgIGN1cnNvcjogcG9pbnRlcjtcbiAgICAgICAgY29sb3I6IHZhcigtLXRleHQtYWNjZW50KTtcbiAgICAgICAgdGV4dC1kZWNvcmF0aW9uOiBub25lO1xuICAgICAgfVxuICAgICAgLmVkaXRuZXh0LWZpbGUtbGluazpob3ZlciB7XG4gICAgICAgIHRleHQtZGVjb3JhdGlvbjogdW5kZXJsaW5lO1xuICAgICAgfVxuICAgICAgLmVkaXRuZXh0LXJvdy1oaWdoIHtcbiAgICAgICAgYmFja2dyb3VuZC1jb2xvcjogcmdiYSgyNTUsIDEwMCwgMTAwLCAwLjEpO1xuICAgICAgfVxuICAgICAgLmVkaXRuZXh0LXJvdy1tZWRpdW0ge1xuICAgICAgICBiYWNrZ3JvdW5kLWNvbG9yOiByZ2JhKDI1NSwgMjAwLCAwLCAwLjEpO1xuICAgICAgfVxuICAgICAgLmVkaXRuZXh0LXJvdy1sb3cge1xuICAgICAgICBiYWNrZ3JvdW5kLWNvbG9yOiByZ2JhKDEwMCwgMjU1LCAxMDAsIDAuMSk7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtYmFkZ2Uge1xuICAgICAgICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7XG4gICAgICAgIHBhZGRpbmc6IDJweCA4cHg7XG4gICAgICAgIGJvcmRlci1yYWRpdXM6IDRweDtcbiAgICAgICAgZm9udC1zaXplOiAwLjhlbTtcbiAgICAgICAgZm9udC13ZWlnaHQ6IGJvbGQ7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtYmFkZ2UtaGlnaCB7XG4gICAgICAgIGJhY2tncm91bmQtY29sb3I6IHJnYmEoMjU1LCAxMDAsIDEwMCwgMC4yKTtcbiAgICAgICAgY29sb3I6ICNkMzJmMmY7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtYmFkZ2UtbWVkaXVtIHtcbiAgICAgICAgYmFja2dyb3VuZC1jb2xvcjogcmdiYSgyNTUsIDIwMCwgMCwgMC4yKTtcbiAgICAgICAgY29sb3I6ICNmNTdjMDA7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtYmFkZ2UtbG93IHtcbiAgICAgICAgYmFja2dyb3VuZC1jb2xvcjogcmdiYSgxMDAsIDI1NSwgMTAwLCAwLjIpO1xuICAgICAgICBjb2xvcjogIzM4OGUzYztcbiAgICAgIH1cbiAgICBgO1xuICAgIGNvbnRhaW5lci5wcmVwZW5kKHN0eWxlRWwpO1xuICAgIFxuICAgIC8vIEhlYWRlclxuICAgIGNvbnN0IGhlYWRlciA9IGNvbnRhaW5lci5jcmVhdGVFbCgnZGl2JywgeyBjbHM6ICdlZGl0bmV4dC1oZWFkZXInIH0pO1xuICAgIGhlYWRlci5jcmVhdGVFbCgnaDInLCB7IHRleHQ6ICdFZGl0TmV4dCBEYXNoYm9hcmQnIH0pO1xuICAgIFxuICAgIGlmICh0aGlzLmlzSnNvbkRhdGEgJiYgdGhpcy5yZXN1bHRzKSB7XG4gICAgICB0aGlzLnJlbmRlckludGVyYWN0aXZlVGFibGUoY29udGFpbmVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRmFsbGJhY2sgdG8gcGxhaW4gdGV4dCBkaXNwbGF5XG4gICAgICBjb25zdCBwcmUgPSBjb250YWluZXIuY3JlYXRlRWwoJ3ByZScpO1xuICAgICAgcHJlLnN0eWxlLndoaXRlU3BhY2UgPSAncHJlLXdyYXAnO1xuICAgICAgcHJlLnNldFRleHQodGhpcy5yZXN1bHRUZXh0KTtcbiAgICB9XG4gIH1cbiAgXG4gIGFzeW5jIHJlbmRlckludGVyYWN0aXZlVGFibGUoY29udGFpbmVyOiBIVE1MRWxlbWVudCkge1xuICAgIGlmICghdGhpcy5yZXN1bHRzIHx8IHRoaXMucmVzdWx0cy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnRhaW5lci5jcmVhdGVFbCgncCcsIHsgdGV4dDogJ05vIHJlc3VsdHMgZm91bmQuJyB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgXG4gICAgLy8gQ3JlYXRlIHRhYmxlXG4gICAgY29uc3QgdGFibGUgPSBjb250YWluZXIuY3JlYXRlRWwoJ3RhYmxlJywgeyBjbHM6ICdlZGl0bmV4dC10YWJsZScgfSk7XG4gICAgXG4gICAgLy8gVGFibGUgaGVhZGVyXG4gICAgY29uc3QgdGhlYWQgPSB0YWJsZS5jcmVhdGVFbCgndGhlYWQnKTtcbiAgICBjb25zdCBoZWFkZXJSb3cgPSB0aGVhZC5jcmVhdGVFbCgndHInKTtcbiAgICBcbiAgICAvLyBBZGQgaGVhZGVycyB3aXRoIHNvcnQgZnVuY3Rpb25hbGl0eVxuICAgIGNvbnN0IGhlYWRlcnMgPSBbXG4gICAgICB7IGtleTogJ2ZpbGUnLCB0ZXh0OiAnRmlsZScgfSxcbiAgICAgIHsga2V5OiAnY29tcG9zaXRlX3Njb3JlJywgdGV4dDogJ1Njb3JlJyB9LFxuICAgICAgeyBrZXk6ICdsbG1fc2NvcmUnLCB0ZXh0OiAnTExNJyB9LFxuICAgICAgeyBrZXk6ICdncmFtbWFyX3Njb3JlJywgdGV4dDogJ0dyYW1tYXInIH0sXG4gICAgICB7IGtleTogJ3JlYWRhYmlsaXR5X3Njb3JlJywgdGV4dDogJ1JlYWRhYmlsaXR5JyB9LFxuICAgICAgeyBrZXk6ICdub3RlcycsIHRleHQ6ICdOb3RlcycgfVxuICAgIF07XG4gICAgXG4gICAgZm9yIChjb25zdCBoZWFkZXIgb2YgaGVhZGVycykge1xuICAgICAgY29uc3QgdGggPSBoZWFkZXJSb3cuY3JlYXRlRWwoJ3RoJyk7XG4gICAgICB0aC5zZXRUZXh0KGhlYWRlci50ZXh0KTtcbiAgICAgIHRoLmRhdGFzZXQua2V5ID0gaGVhZGVyLmtleTtcbiAgICAgIFxuICAgICAgLy8gQWRkIGNsaWNrIGhhbmRsZXIgZm9yIHNvcnRpbmdcbiAgICAgIHRoLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICB0aGlzLnNvcnRSZXN1bHRzKGhlYWRlci5rZXkpO1xuICAgICAgICB0aGlzLnJlZnJlc2hUYWJsZSh0YWJsZSk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgXG4gICAgLy8gVGFibGUgYm9keVxuICAgIGNvbnN0IHRib2R5ID0gdGFibGUuY3JlYXRlRWwoJ3Rib2R5Jyk7XG4gICAgdGhpcy5wb3B1bGF0ZVRhYmxlUm93cyh0Ym9keSk7XG4gIH1cbiAgXG4gIHBvcHVsYXRlVGFibGVSb3dzKHRib2R5OiBIVE1MRWxlbWVudCkge1xuICAgIGlmICghdGhpcy5yZXN1bHRzKSByZXR1cm47XG4gICAgXG4gICAgdGJvZHkuZW1wdHkoKTtcbiAgICBcbiAgICBmb3IgKGNvbnN0IHJlc3VsdCBvZiB0aGlzLnJlc3VsdHMpIHtcbiAgICAgIGNvbnN0IHJvdyA9IHRib2R5LmNyZWF0ZUVsKCd0cicpO1xuICAgICAgXG4gICAgICAvLyBBZGQgcm93IGNsYXNzIGJhc2VkIG9uIHNjb3JlXG4gICAgICBpZiAocmVzdWx0LmNvbXBvc2l0ZV9zY29yZSA+PSA3MCkge1xuICAgICAgICByb3cuYWRkQ2xhc3MoJ2VkaXRuZXh0LXJvdy1oaWdoJyk7XG4gICAgICB9IGVsc2UgaWYgKHJlc3VsdC5jb21wb3NpdGVfc2NvcmUgPj0gNDApIHtcbiAgICAgICAgcm93LmFkZENsYXNzKCdlZGl0bmV4dC1yb3ctbWVkaXVtJyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByb3cuYWRkQ2xhc3MoJ2VkaXRuZXh0LXJvdy1sb3cnKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gRmlsZSBjZWxsIHdpdGggY2xpY2thYmxlIGxpbmtcbiAgICAgIGNvbnN0IGZpbGVDZWxsID0gcm93LmNyZWF0ZUVsKCd0ZCcpO1xuICAgICAgY29uc3QgZmlsZUxpbmsgPSBmaWxlQ2VsbC5jcmVhdGVFbCgnYScsIHsgXG4gICAgICAgIGNsczogJ2VkaXRuZXh0LWZpbGUtbGluaycsXG4gICAgICAgIHRleHQ6IHRoaXMuZ2V0RmlsZU5hbWUocmVzdWx0LmZpbGUpXG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgZmlsZUxpbmsuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IHRoaXMub3BlbkZpbGUocmVzdWx0LmZpbGUpO1xuICAgICAgfSk7XG4gICAgICBcbiAgICAgIC8vIFNjb3JlIHdpdGggY29sb3JlZCBiYWRnZVxuICAgICAgY29uc3Qgc2NvcmVDZWxsID0gcm93LmNyZWF0ZUVsKCd0ZCcpO1xuICAgICAgY29uc3Qgc2NvcmVCYWRnZSA9IHNjb3JlQ2VsbC5jcmVhdGVFbCgnc3BhbicsIHtcbiAgICAgICAgY2xzOiBgZWRpdG5leHQtYmFkZ2UgJHt0aGlzLmdldFNjb3JlQ2xhc3MocmVzdWx0LmNvbXBvc2l0ZV9zY29yZSl9YCxcbiAgICAgICAgdGV4dDogcmVzdWx0LmNvbXBvc2l0ZV9zY29yZS50b0ZpeGVkKDEpXG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgLy8gT3RoZXIgbWV0cmljc1xuICAgICAgcm93LmNyZWF0ZUVsKCd0ZCcsIHsgdGV4dDogcmVzdWx0LmxsbV9zY29yZS50b1N0cmluZygpIH0pO1xuICAgICAgcm93LmNyZWF0ZUVsKCd0ZCcsIHsgdGV4dDogcmVzdWx0LmdyYW1tYXJfc2NvcmUudG9GaXhlZCgxKSB9KTtcbiAgICAgIHJvdy5jcmVhdGVFbCgndGQnLCB7IHRleHQ6IHJlc3VsdC5yZWFkYWJpbGl0eV9zY29yZS50b0ZpeGVkKDEpIH0pO1xuICAgICAgcm93LmNyZWF0ZUVsKCd0ZCcsIHsgdGV4dDogcmVzdWx0Lm5vdGVzIH0pO1xuICAgIH1cbiAgfVxuICBcbiAgc29ydFJlc3VsdHMoa2V5OiBzdHJpbmcpIHtcbiAgICBpZiAoIXRoaXMucmVzdWx0cykgcmV0dXJuO1xuICAgIFxuICAgIGNvbnN0IGlzTnVtZXJpYyA9IGtleSAhPT0gJ2ZpbGUnICYmIGtleSAhPT0gJ25vdGVzJztcbiAgICBcbiAgICB0aGlzLnJlc3VsdHMuc29ydCgoYSwgYikgPT4ge1xuICAgICAgaWYgKGlzTnVtZXJpYykge1xuICAgICAgICByZXR1cm4gYltrZXldIC0gYVtrZXldOyAvLyBEZXNjZW5kaW5nIGZvciBudW1lcmljXG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gU3RyaW5nKGFba2V5XSkubG9jYWxlQ29tcGFyZShTdHJpbmcoYltrZXldKSk7IC8vIEFzY2VuZGluZyBmb3IgdGV4dFxuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIFxuICByZWZyZXNoVGFibGUodGFibGU6IEhUTUxFbGVtZW50KSB7XG4gICAgY29uc3QgdGJvZHkgPSB0YWJsZS5xdWVyeVNlbGVjdG9yKCd0Ym9keScpO1xuICAgIGlmICh0Ym9keSkge1xuICAgICAgdGhpcy5wb3B1bGF0ZVRhYmxlUm93cyh0Ym9keSk7XG4gICAgfVxuICB9XG4gIFxuICBnZXRGaWxlTmFtZShwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHBhcnRzID0gcGF0aC5zcGxpdCgvW1xcL1xcXFxdLyk7XG4gICAgcmV0dXJuIHBhcnRzW3BhcnRzLmxlbmd0aCAtIDFdO1xuICB9XG4gIFxuICBnZXRTY29yZUNsYXNzKHNjb3JlOiBudW1iZXIpOiBzdHJpbmcge1xuICAgIGlmIChzY29yZSA+PSA3MCkgcmV0dXJuICdlZGl0bmV4dC1iYWRnZS1oaWdoJztcbiAgICBpZiAoc2NvcmUgPj0gNDApIHJldHVybiAnZWRpdG5leHQtYmFkZ2UtbWVkaXVtJztcbiAgICByZXR1cm4gJ2VkaXRuZXh0LWJhZGdlLWxvdyc7XG4gIH1cbiAgXG4gIGFzeW5jIG9wZW5GaWxlKGZpbGVQYXRoOiBzdHJpbmcpIHtcbiAgICB0cnkge1xuICAgICAgLy8gRmluZCB0aGUgZmlsZSBpbiB0aGUgdmF1bHRcbiAgICAgIGNvbnN0IGZpbGVzID0gdGhpcy5hcHAudmF1bHQuZ2V0RmlsZXMoKTtcbiAgICAgIGxldCB0YXJnZXRGaWxlOiBURmlsZSB8IG51bGwgPSBudWxsO1xuICAgICAgXG4gICAgICAvLyBGaXJzdCB0cnkgZGlyZWN0IHBhdGggbWF0Y2hcbiAgICAgIHRhcmdldEZpbGUgPSBmaWxlcy5maW5kKGYgPT4gZi5wYXRoID09PSBmaWxlUGF0aCkgfHwgbnVsbDtcbiAgICAgIFxuICAgICAgLy8gSWYgbm90IGZvdW5kLCB0cnkgdGhlIGZpbGVuYW1lXG4gICAgICBpZiAoIXRhcmdldEZpbGUpIHtcbiAgICAgICAgY29uc3QgZmlsZU5hbWUgPSB0aGlzLmdldEZpbGVOYW1lKGZpbGVQYXRoKTtcbiAgICAgICAgdGFyZ2V0RmlsZSA9IGZpbGVzLmZpbmQoZiA9PiBmLm5hbWUgPT09IGZpbGVOYW1lKSB8fCBudWxsO1xuICAgICAgfVxuICAgICAgXG4gICAgICBpZiAodGFyZ2V0RmlsZSkge1xuICAgICAgICAvLyBPcGVuIHRoZSBmaWxlIGluIGEgbmV3IGxlYWZcbiAgICAgICAgYXdhaXQgdGhpcy5hcHAud29ya3NwYWNlLmdldExlYWYoZmFsc2UpLm9wZW5GaWxlKHRhcmdldEZpbGUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbmV3IE5vdGljZShgRmlsZSBub3QgZm91bmQ6ICR7ZmlsZVBhdGh9YCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJFcnJvciBvcGVuaW5nIGZpbGU6XCIsIGVycik7XG4gICAgICBuZXcgTm90aWNlKGBFcnJvciBvcGVuaW5nIGZpbGU6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgb25DbG9zZSgpIHtcbiAgICAvLyBDbGVhbiB1cFxuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTZXR0aW5ncyBUYWIgVUlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5jbGFzcyBFZGl0TmV4dFNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgcGx1Z2luOiBFZGl0TmV4dFBsdWdpbjtcblxuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgcGx1Z2luOiBFZGl0TmV4dFBsdWdpbikge1xuICAgIHN1cGVyKGFwcCwgcGx1Z2luKTtcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgICBMb2dnZXIuZGVidWcoXCJTZXR0aW5ncyB0YWIgaW5pdGlhbGl6ZWRcIik7XG4gIH1cblxuICBkaXNwbGF5KCk6IHZvaWQge1xuICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgTG9nZ2VyLmRlYnVnKFwiU2V0dGluZ3MgdGFiIGRpc3BsYXllZFwiKTtcblxuICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICBjb250YWluZXJFbC5jcmVhdGVFbCgnaDInLCB7IHRleHQ6ICdFZGl0TmV4dCBSYW5rZXIgU2V0dGluZ3MnIH0pO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnT3BlbkFJIEFQSSBLZXknKVxuICAgICAgLnNldERlc2MoJ1JlcXVpcmVkIHRvIHF1ZXJ5IEdQVCBtb2RlbHMnKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XG4gICAgICAgIHRleHRcbiAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJ3NrLVhYWFgnKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vcGVuYWlBcGlLZXkpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Mub3BlbmFpQXBpS2V5ID0gdmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdQeXRob24gUGF0aCcpXG4gICAgICAuc2V0RGVzYygnUGF0aCB0byBQeXRob24gZXhlY3V0YWJsZSAod2l0aCBkZXBlbmRlbmNpZXMgaW5zdGFsbGVkKScpXG4gICAgICAuYWRkVGV4dCgodGV4dCkgPT5cbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcigncHl0aG9uMycpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnB5dGhvblBhdGgpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MucHl0aG9uUGF0aCA9IHZhbHVlLnRyaW0oKSB8fCAncHl0aG9uMyc7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ1dlaWdodHMnKVxuICAgICAgLnNldERlc2MoJ1RocmVlIG51bWJlcnMgZm9yIExMTSwgR3JhbW1hciwgUmVhZGFiaWxpdHkgd2VpZ2h0cyAoc3VtIDEuMCknKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XG4gICAgICAgIHRleHRcbiAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJzAuNiAwLjIgMC4yJylcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3Mud2VpZ2h0cy5qb2luKCcgJykpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcGFydHMgPSB2YWx1ZS5zcGxpdCgvXFxzKy8pLm1hcChOdW1iZXIpO1xuICAgICAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMyAmJiBwYXJ0cy5ldmVyeSgobikgPT4gIWlzTmFOKG4pKSkge1xuICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy53ZWlnaHRzID0gcGFydHMgYXMgW251bWJlciwgbnVtYmVyLCBudW1iZXJdO1xuICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ09wZW5BSSBNb2RlbCcpXG4gICAgICAuc2V0RGVzYygnTW9kZWwgdG8gdXNlIGZvciBzY29yaW5nJylcbiAgICAgIC5hZGRUZXh0KCh0ZXh0KSA9PlxuICAgICAgICB0ZXh0LnNldFBsYWNlaG9sZGVyKCdncHQtNG8tbWluaScpLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsKS5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5tb2RlbCA9IHZhbHVlLnRyaW0oKTtcbiAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdUYXJnZXQgRm9sZGVyJylcbiAgICAgIC5zZXREZXNjKCdSZWxhdGl2ZSBwYXRoIGluc2lkZSB2YXVsdDsgbGVhdmUgYmxhbmsgZm9yIGVudGlyZSB2YXVsdCcpXG4gICAgICAuYWRkVGV4dCgodGV4dCkgPT5cbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignZHJhZnRzJylcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MudGFyZ2V0Rm9sZGVyKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnRhcmdldEZvbGRlciA9IHZhbHVlLnRyaW0oKTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgLy8gRXhjbHVkZSBzdWJmb2xkZXJzIHNldHRpbmdcbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdFeGNsdWRlIFN1YmZvbGRlcnMnKVxuICAgICAgLnNldERlc2MoJ0NvbW1hLXNlcGFyYXRlZCBsaXN0IG9mIHN1YmZvbGRlcnMgKHJlbGF0aXZlIHRvIGZvbGRlciBzcGVjaWZpZWQgYWJvdmUpIHRvIGV4Y2x1ZGUnKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XG4gICAgICAgIHRleHRcbiAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJ2RyYWZ0cy9vbGQsYXJjaGl2ZScpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmV4Y2x1ZGVGb2xkZXJzLmpvaW4oJywnKSlcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICBMb2dnZXIuZGVidWcoJ1NldHRpbmcgZXhjbHVkZSBmb2xkZXJzOicsIHZhbHVlKTtcbiAgICAgICAgICAgIC8vIFNwbGl0IGJ5IGNvbW1hLCB0cmltIHdoaXRlc3BhY2UsIG5vcm1hbGl6ZSBwYXRocywgYW5kIGZpbHRlciBlbXB0eSBzdHJpbmdzXG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5leGNsdWRlRm9sZGVycyA9IHZhbHVlXG4gICAgICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgICAgIC5tYXAoKHMpID0+IG5vcm1hbGl6ZVBhdGgocy50cmltKCkpKVxuICAgICAgICAgICAgICAuZmlsdGVyKChzKSA9PiBzKTtcbiAgICAgICAgICAgIExvZ2dlci5kZWJ1ZygnUGFyc2VkIGV4Y2x1ZGUgZm9sZGVyczonLCB0aGlzLnBsdWdpbi5zZXR0aW5ncy5leGNsdWRlRm9sZGVycyk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIC8vIEFkZCBkYXNoYm9hcmQgYXMgaG9tZSBwYWdlIHNldHRpbmdcbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdTZXQgRGFzaGJvYXJkIGFzIEhvbWUgUGFnZScpXG4gICAgICAuc2V0RGVzYygnV2hlbiBlbmFibGVkLCB0aGUgRWRpdE5leHQgZGFzaGJvYXJkIHdpbGwgYmUgc2hvd24gd2hlbiBvcGVuaW5nIE9ic2lkaWFuJylcbiAgICAgIC5hZGRUb2dnbGUoKHRvZ2dsZSkgPT5cbiAgICAgICAgdG9nZ2xlXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmRhc2hib2FyZEFzSG9tZVBhZ2UpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuZGFzaGJvYXJkQXNIb21lUGFnZSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG4gIH1cbn0gIl0sIm5hbWVzIjpbIm5vcm1hbGl6ZVBhdGgiLCJzcGF3biIsIlBsdWdpbiIsIk5vdGljZSIsIkl0ZW1WaWV3IiwiUGx1Z2luU2V0dGluZ1RhYiIsIlNldHRpbmciXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFBQTtBQU1BO0FBQ0EsTUFBTSxNQUFNLENBQUE7QUFTVixJQUFBLE9BQU8sS0FBSyxDQUFDLE9BQWUsRUFBRSxHQUFHLElBQVcsRUFBQTtRQUMxQyxJQUFJLE1BQU0sQ0FBQyxLQUFLLElBQUksTUFBTSxDQUFDLEtBQUssRUFBRTtBQUNoQyxZQUFBLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQSxDQUFBLEVBQUksTUFBTSxDQUFDLE1BQU0sQ0FBSyxFQUFBLEVBQUEsT0FBTyxDQUFFLENBQUEsRUFBRSxHQUFHLElBQUksQ0FBQzs7O0FBSTNELElBQUEsT0FBTyxJQUFJLENBQUMsT0FBZSxFQUFFLEdBQUcsSUFBVyxFQUFBO1FBQ3pDLElBQUksTUFBTSxDQUFDLEtBQUssSUFBSSxNQUFNLENBQUMsSUFBSSxFQUFFO0FBQy9CLFlBQUEsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFBLENBQUEsRUFBSSxNQUFNLENBQUMsTUFBTSxDQUFLLEVBQUEsRUFBQSxPQUFPLENBQUUsQ0FBQSxFQUFFLEdBQUcsSUFBSSxDQUFDOzs7QUFJMUQsSUFBQSxPQUFPLElBQUksQ0FBQyxPQUFlLEVBQUUsR0FBRyxJQUFXLEVBQUE7UUFDekMsSUFBSSxNQUFNLENBQUMsS0FBSyxJQUFJLE1BQU0sQ0FBQyxJQUFJLEVBQUU7QUFDL0IsWUFBQSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUEsQ0FBQSxFQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUssRUFBQSxFQUFBLE9BQU8sQ0FBRSxDQUFBLEVBQUUsR0FBRyxJQUFJLENBQUM7OztBQUkxRCxJQUFBLE9BQU8sS0FBSyxDQUFDLE9BQWUsRUFBRSxHQUFHLElBQVcsRUFBQTtRQUMxQyxJQUFJLE1BQU0sQ0FBQyxLQUFLLElBQUksTUFBTSxDQUFDLEtBQUssRUFBRTtBQUNoQyxZQUFBLE9BQU8s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
