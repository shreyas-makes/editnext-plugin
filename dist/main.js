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
            // Add settings tab
            this.addSettingTab(new EditNextSettingTab(this.app, this));
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
        Logger.info('Running EditNext ranker command...');
        new obsidian.Notice('Running EditNext ranker...');
        // Show progress in status bar
        if (this.statusBarItem) {
            this.statusBarItem.setText('EditNext: Analyzing files...');
            this.statusBarItem.style.display = 'block';
        }
        try {
            const results = await runRanker(this.app, this, this.settings);
            Logger.debug("Ranker completed successfully");
            // Hide status bar item
            if (this.statusBarItem) {
                this.statusBarItem.style.display = 'none';
            }
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
                new obsidian.Notice(`Top edit priority: ${fileName} (score: ${topFile.composite_score.toFixed(1)})`);
            }
        }
        catch (err) {
            // Hide status bar on error
            if (this.statusBarItem) {
                this.statusBarItem.style.display = 'none';
            }
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
}
const VIEW_TYPE = 'editnext-results';
class EditNextResultView extends obsidian.ItemView {
    constructor(leaf, resultText) {
        super(leaf);
        this.resultText = resultText;
        this.isJsonData = false;
        this.results = null;
        this.sortColumn = 'composite_score';
        this.sortDirection = 'desc';
        
        try {
            this.results = JSON.parse(resultText);
            this.isJsonData = Array.isArray(this.results);
        }
        catch (e) {
            console.error("Failed to parse JSON:", e);
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
    async renderInteractiveTable(container) {
        if (!this.results || this.results.length === 0) {
            const emptyState = container.createEl('div', { cls: 'editnext-empty-state' });
            emptyState.createEl('p', { text: 'No results found.' });
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
            
            // Create a wrapper div for the header content
            const headerContent = th.createEl('div', { 
                cls: 'editnext-header-content',
                text: header.text
            });
            
            if (header.key !== 'notes') {
                // Add sort indicator
                const sortIndicator = headerContent.createEl('span', { 
                    cls: 'editnext-sort-indicator' 
                });
                
                // Update sort indicator
                if (this.sortColumn === header.key) {
                    sortIndicator.textContent = this.sortDirection === 'asc' ? ' ↑' : ' ↓';
                }
                
                // Add sort functionality
                th.addEventListener('click', () => {
                    this.handleSort(header.key);
                });
            }
        }
        
        // Table body
        const tbody = table.createEl('tbody');
        this.populateTableRows(tbody);
    }
    populateTableRows(tbody) {
        if (!this.results) return;
        
        tbody.empty();
        
        for (const result of this.results) {
            const row = tbody.createEl('tr');
            
            // File cell with clickable link
            const fileCell = row.createEl('td');
            const fileLink = fileCell.createEl('a', { 
                cls: 'editnext-file-link',
                text: this.getFileName(result.file)
            });
            
            fileLink.addEventListener('click', async () => {
                await this.openFile(result.file);
            });
            
            // Score cell with simple badge
            const scoreCell = row.createEl('td');
            scoreCell.createEl('span', {
                cls: 'editnext-badge',
                text: result.composite_score.toFixed(1)
            });
            
            // Other metrics - clean presentation
            row.createEl('td', { text: result.llm_score.toString() });
            row.createEl('td', { text: result.grammar_score.toFixed(1) });
            row.createEl('td', { text: result.readability_score.toFixed(1) });
            row.createEl('td', { text: result.notes });
        }
    }
    handleSort(column) {
        // If clicking the same column, toggle direction
        if (this.sortColumn === column) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            // New column, default to descending for scores (higher first), ascending for text
            this.sortColumn = column;
            this.sortDirection = ['file', 'notes'].includes(column) ? 'asc' : 'desc';
        }
        
        // Sort the results
        this.sortResults();
        
        // Refresh the table
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('editnext-dashboard');
        
        // Re-add header
        const header = container.createEl('div', { cls: 'editnext-header' });
        header.createEl('h2', { text: 'EditNext Dashboard' });
        
        // Re-render table
        this.renderInteractiveTable(container);
    }
    
    sortResults() {
        if (!this.results) return;
        
        this.results.sort((a, b) => {
            let valueA, valueB;
            
            // Handle different data types
            if (this.sortColumn === 'file' || this.sortColumn === 'notes') {
                valueA = a[this.sortColumn] || '';
                valueB = b[this.sortColumn] || '';
            } else {
                valueA = parseFloat(a[this.sortColumn]) || 0;
                valueB = parseFloat(b[this.sortColumn]) || 0;
            }
            
            // Compare based on type
            if (typeof valueA === 'string') {
                const comparison = valueA.localeCompare(valueB);
                return this.sortDirection === 'asc' ? comparison : -comparison;
            } else {
                return this.sortDirection === 'asc' ? valueA - valueB : valueB - valueA;
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
    }
}

module.exports = EditNextPlugin;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLi4vc3JjL21haW4udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQHRzLW5vY2hlY2tcbmltcG9ydCB7IFBsdWdpbiwgTm90aWNlLCBBcHAsIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsIG5vcm1hbGl6ZVBhdGggfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgZnMgZnJvbSAnZnMnO1xuaW1wb3J0IHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBzcGF3biB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuXG4vLyBDdXN0b20gbG9nZ2VyIHdpdGggbGV2ZWxzXG5jbGFzcyBMb2dnZXIge1xuICBzdGF0aWMgREVCVUcgPSAwO1xuICBzdGF0aWMgSU5GTyA9IDE7XG4gIHN0YXRpYyBXQVJOID0gMjtcbiAgc3RhdGljIEVSUk9SID0gMztcbiAgXG4gIHN0YXRpYyBsZXZlbCA9IExvZ2dlci5ERUJVRzsgLy8gU2V0IG1pbmltdW0gbG9nIGxldmVsXG4gIHN0YXRpYyBwcmVmaXggPSBcIkVkaXROZXh0XCI7XG4gIFxuICBzdGF0aWMgZGVidWcobWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSkge1xuICAgIGlmIChMb2dnZXIubGV2ZWwgPD0gTG9nZ2VyLkRFQlVHKSB7XG4gICAgICBjb25zb2xlLmRlYnVnKGBbJHtMb2dnZXIucHJlZml4fV0gJHttZXNzYWdlfWAsIC4uLmFyZ3MpO1xuICAgIH1cbiAgfVxuICBcbiAgc3RhdGljIGluZm8obWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSkge1xuICAgIGlmIChMb2dnZXIubGV2ZWwgPD0gTG9nZ2VyLklORk8pIHtcbiAgICAgIGNvbnNvbGUuaW5mbyhgWyR7TG9nZ2VyLnByZWZpeH1dICR7bWVzc2FnZX1gLCAuLi5hcmdzKTtcbiAgICB9XG4gIH1cbiAgXG4gIHN0YXRpYyB3YXJuKG1lc3NhZ2U6IHN0cmluZywgLi4uYXJnczogYW55W10pIHtcbiAgICBpZiAoTG9nZ2VyLmxldmVsIDw9IExvZ2dlci5XQVJOKSB7XG4gICAgICBjb25zb2xlLndhcm4oYFske0xvZ2dlci5wcmVmaXh9XSAke21lc3NhZ2V9YCwgLi4uYXJncyk7XG4gICAgfVxuICB9XG4gIFxuICBzdGF0aWMgZXJyb3IobWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSkge1xuICAgIGlmIChMb2dnZXIubGV2ZWwgPD0gTG9nZ2VyLkVSUk9SKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGBbJHtMb2dnZXIucHJlZml4fV0gJHttZXNzYWdlfWAsIC4uLmFyZ3MpO1xuICAgIH1cbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU2V0dGluZ3MgZGVmaW5pdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmludGVyZmFjZSBFZGl0TmV4dFBsdWdpblNldHRpbmdzIHtcbiAgb3BlbmFpQXBpS2V5OiBzdHJpbmc7XG4gIHB5dGhvblBhdGg6IHN0cmluZztcbiAgd2VpZ2h0czogW251bWJlciwgbnVtYmVyLCBudW1iZXJdO1xuICBtb2RlbDogc3RyaW5nO1xuICB0YXJnZXRGb2xkZXI6IHN0cmluZzsgLy8gcmVsYXRpdmUgdG8gdmF1bHQgcm9vdFxufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBFZGl0TmV4dFBsdWdpblNldHRpbmdzID0ge1xuICBvcGVuYWlBcGlLZXk6ICcnLFxuICBweXRob25QYXRoOiAncHl0aG9uMycsXG4gIHdlaWdodHM6IFswLjYsIDAuMiwgMC4yXSxcbiAgbW9kZWw6ICdncHQtNG8tbWluaScsXG4gIHRhcmdldEZvbGRlcjogJycsXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSGVscGVyIHRvIHJ1biBleHRlcm5hbCBweXRob24gcHJvY2Vzc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmFzeW5jIGZ1bmN0aW9uIHJ1blJhbmtlcihhcHA6IEFwcCwgcGx1Z2luOiBFZGl0TmV4dFBsdWdpbiwgc2V0dGluZ3M6IEVkaXROZXh0UGx1Z2luU2V0dGluZ3MpOiBQcm9taXNlPGFueT4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIC8vIERldGVybWluZSBmb2xkZXIgYWJzb2x1dGUgcGF0aFxuICAgIGNvbnN0IHZhdWx0UGF0aCA9IGFwcC52YXVsdC5hZGFwdGVyLmdldEJhc2VQYXRoKCk7XG4gICAgY29uc3QgdGFyZ2V0RGlyID0gc2V0dGluZ3MudGFyZ2V0Rm9sZGVyXG4gICAgICA/IHBhdGguam9pbih2YXVsdFBhdGgsIG5vcm1hbGl6ZVBhdGgoc2V0dGluZ3MudGFyZ2V0Rm9sZGVyKSlcbiAgICAgIDogdmF1bHRQYXRoO1xuICAgIFxuICAgIExvZ2dlci5kZWJ1ZyhcIlJ1bm5pbmcgcmFua2VyIHdpdGggc2V0dGluZ3M6XCIsIHNldHRpbmdzKTtcbiAgICBMb2dnZXIuZGVidWcoXCJUYXJnZXQgZGlyZWN0b3J5OlwiLCB0YXJnZXREaXIpO1xuXG4gICAgLy8gRW5zdXJlIGRpcmVjdG9yeSBleGlzdHNcbiAgICBpZiAoIWZzLmV4aXN0c1N5bmModGFyZ2V0RGlyKSkge1xuICAgICAgY29uc3QgZXJyb3IgPSBgVGFyZ2V0IGRpcmVjdG9yeSBub3QgZm91bmQ6ICR7dGFyZ2V0RGlyfWA7XG4gICAgICBMb2dnZXIuZXJyb3IoZXJyb3IpO1xuICAgICAgcmVqZWN0KG5ldyBFcnJvcihlcnJvcikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFRyeSBtdWx0aXBsZSBwb3NzaWJsZSBzY3JpcHQgbG9jYXRpb25zXG4gICAgY29uc3QgcG9zc2libGVTY3JpcHRQYXRocyA9IFtcbiAgICAgIC8vIFRyeSBpbiBwbHVnaW4ncyBkYXRhIGRpcmVjdG9yeSAocmVsYXRpdmUgdG8gcGx1Z2luIGxvY2F0aW9uKVxuICAgICAgcGF0aC5qb2luKHBsdWdpbi5tYW5pZmVzdC5kaXIsICdkYXRhJywgJ2Vzc2F5LXF1YWxpdHktcmFua2VyLnB5JyksXG4gICAgICAvLyBUcnkgaW4gdGhlIHZhdWx0IHJvb3RcbiAgICAgIHBhdGguam9pbih2YXVsdFBhdGgsICdlc3NheS1xdWFsaXR5LXJhbmtlci5weScpLFxuICAgICAgLy8gVHJ5IGluIGN1cnJlbnQgZXhlY3V0aW9uIGRpcmVjdG9yeVxuICAgICAgcGF0aC5qb2luKHByb2Nlc3MuY3dkKCksICdlc3NheS1xdWFsaXR5LXJhbmtlci5weScpLFxuICAgICAgLy8gVHJ5IGluIHBhcmVudCBkaXJlY3RvcnlcbiAgICAgIHBhdGguam9pbihwcm9jZXNzLmN3ZCgpLCAnLi4nLCAnZXNzYXktcXVhbGl0eS1yYW5rZXIucHknKSxcbiAgICAgIC8vIFBhdGggcmVsYXRpdmUgdG8gdGhlIHZhdWx0IChhc3N1bWluZyBwbHVnaW4gaXMgaW5zdGFsbGVkIGluIC5vYnNpZGlhbi9wbHVnaW5zKVxuICAgICAgcGF0aC5qb2luKHZhdWx0UGF0aCwgJy5vYnNpZGlhbicsICdwbHVnaW5zJywgJ2VkaXRuZXh0LXBsdWdpbicsICdkYXRhJywgJ2Vzc2F5LXF1YWxpdHktcmFua2VyLnB5JylcbiAgICBdO1xuICAgIFxuICAgIGxldCBzY3JpcHRQYXRoID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHRyeVBhdGggb2YgcG9zc2libGVTY3JpcHRQYXRocykge1xuICAgICAgTG9nZ2VyLmRlYnVnKGBDaGVja2luZyBzY3JpcHQgcGF0aDogJHt0cnlQYXRofWApO1xuICAgICAgaWYgKGZzLmV4aXN0c1N5bmModHJ5UGF0aCkpIHtcbiAgICAgICAgc2NyaXB0UGF0aCA9IHRyeVBhdGg7XG4gICAgICAgIExvZ2dlci5kZWJ1ZyhgRm91bmQgc2NyaXB0IGF0OiAke3NjcmlwdFBhdGh9YCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICBcbiAgICAvLyBDaGVjayBpZiBzY3JpcHQgZXhpc3RzXG4gICAgaWYgKCFzY3JpcHRQYXRoKSB7XG4gICAgICBjb25zdCBlcnJvciA9IGBTY3JpcHQgbm90IGZvdW5kIGluIGFueSBvZiB0aGUgZXhwZWN0ZWQgbG9jYXRpb25zLiBQbGVhc2UgcGxhY2UgZXNzYXktcXVhbGl0eS1yYW5rZXIucHkgaW4geW91ciBwbHVnaW4ncyBkYXRhIGZvbGRlciBvciB2YXVsdCByb290LmA7XG4gICAgICBMb2dnZXIuZXJyb3IoZXJyb3IpO1xuICAgICAgcmVqZWN0KG5ldyBFcnJvcihlcnJvcikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBcbiAgICBjb25zdCBjbWRBcmdzOiBzdHJpbmdbXSA9IFtcbiAgICAgIHNjcmlwdFBhdGgsXG4gICAgICB0YXJnZXREaXIsXG4gICAgICAnLS13ZWlnaHRzJyxcbiAgICAgIC4uLnNldHRpbmdzLndlaWdodHMubWFwKCh3KSA9PiB3LnRvU3RyaW5nKCkpLFxuICAgICAgJy0tbW9kZWwnLFxuICAgICAgc2V0dGluZ3MubW9kZWwsXG4gICAgICAnLS1qc29uJyAvLyBBbHdheXMgcmVxdWVzdCBKU09OIG91dHB1dFxuICAgIF07XG4gICAgXG4gICAgTG9nZ2VyLmRlYnVnKFwiQ29tbWFuZDpcIiwgc2V0dGluZ3MucHl0aG9uUGF0aCwgY21kQXJncy5qb2luKCcgJykpO1xuXG4gICAgLy8gUHJvdmlkZSBlbnZpcm9ubWVudFxuICAgIGNvbnN0IGVudiA9IHsgLi4ucHJvY2Vzcy5lbnYsIE9QRU5BSV9BUElfS0VZOiBzZXR0aW5ncy5vcGVuYWlBcGlLZXkgfTtcbiAgICBMb2dnZXIuZGVidWcoXCJBUEkga2V5IHNldDpcIiwgISFzZXR0aW5ncy5vcGVuYWlBcGlLZXkpO1xuXG4gICAgLy8gU3Bhd24gY2hpbGQgcHJvY2Vzc1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjaGlsZCA9IHNwYXduKHNldHRpbmdzLnB5dGhvblBhdGgsIGNtZEFyZ3MsIHsgZW52IH0pO1xuXG4gICAgICBsZXQgb3V0cHV0ID0gJyc7XG4gICAgICBsZXQgZXJyb3JPdXRwdXQgPSAnJztcbiAgICAgIFxuICAgICAgY2hpbGQuc3Rkb3V0Lm9uKCdkYXRhJywgKGRhdGE6IEJ1ZmZlcikgPT4ge1xuICAgICAgICBjb25zdCBjaHVuayA9IGRhdGEudG9TdHJpbmcoKTtcbiAgICAgICAgTG9nZ2VyLmRlYnVnKGBQeXRob24gc3Rkb3V0OiAke2NodW5rfWApO1xuICAgICAgICBvdXRwdXQgKz0gY2h1bms7XG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgY2hpbGQuc3RkZXJyLm9uKCdkYXRhJywgKGRhdGE6IEJ1ZmZlcikgPT4ge1xuICAgICAgICBjb25zdCBjaHVuayA9IGRhdGEudG9TdHJpbmcoKTtcbiAgICAgICAgTG9nZ2VyLmVycm9yKGBQeXRob24gc3RkZXJyOiAke2NodW5rfWApO1xuICAgICAgICBlcnJvck91dHB1dCArPSBjaHVuaztcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICBjaGlsZC5vbignZXJyb3InLCAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBMb2dnZXIuZXJyb3IoXCJQcm9jZXNzIGVycm9yOlwiLCBlcnIpO1xuICAgICAgICByZWplY3QoZXJyKTtcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICBjaGlsZC5vbignY2xvc2UnLCAoY29kZTogbnVtYmVyKSA9PiB7XG4gICAgICAgIExvZ2dlci5kZWJ1ZyhgUHJvY2VzcyBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX1gKTtcbiAgICAgICAgaWYgKGNvZGUgPT09IDApIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gVHJ5IHRvIHBhcnNlIHRoZSBKU09OIG91dHB1dFxuICAgICAgICAgICAgY29uc3QgcmVzdWx0cyA9IEpTT04ucGFyc2Uob3V0cHV0KTtcbiAgICAgICAgICAgIHJlc29sdmUocmVzdWx0cyk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gRmFsbGJhY2sgdG8gcmF3IHRleHQgaWYgSlNPTiBwYXJzaW5nIGZhaWxzXG4gICAgICAgICAgICBMb2dnZXIud2FybihcIkZhaWxlZCB0byBwYXJzZSBKU09OIG91dHB1dCwgcmV0dXJuaW5nIHJhdyB0ZXh0OlwiLCBlKTtcbiAgICAgICAgICAgIHJlc29sdmUob3V0cHV0KTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgZXJyb3IgPSBgUHJvY2VzcyBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX0ke2Vycm9yT3V0cHV0ID8gJzogJyArIGVycm9yT3V0cHV0IDogJyd9YDtcbiAgICAgICAgICBMb2dnZXIuZXJyb3IoZXJyb3IpO1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoZXJyb3IpKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJGYWlsZWQgdG8gc3Bhd24gcHJvY2VzczpcIiwgZXJyKTtcbiAgICAgIHJlamVjdChlcnIpO1xuICAgIH1cbiAgfSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQbHVnaW4gaW1wbGVtZW50YXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBFZGl0TmV4dFBsdWdpbiBleHRlbmRzIFBsdWdpbiB7XG4gIHNldHRpbmdzOiBFZGl0TmV4dFBsdWdpblNldHRpbmdzID0gREVGQVVMVF9TRVRUSU5HUztcbiAgcmliYm9uRWw6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIHN0YXR1c0Jhckl0ZW06IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cbiAgYXN5bmMgb25sb2FkKCkge1xuICAgIExvZ2dlci5pbmZvKCdMb2FkaW5nIEVkaXROZXh0IFJhbmtlciBwbHVnaW4nKTtcbiAgICBcbiAgICB0cnkge1xuICAgICAgLy8gTG9nIHBsdWdpbiBkZXRhaWxzXG4gICAgICBMb2dnZXIuZGVidWcoXCJQbHVnaW4gZGlyZWN0b3J5OlwiLCB0aGlzLm1hbmlmZXN0LmRpcik7XG4gICAgICBMb2dnZXIuZGVidWcoXCJQbHVnaW4gdmVyc2lvbjpcIiwgdGhpcy5tYW5pZmVzdC52ZXJzaW9uKTtcbiAgICAgIFxuICAgICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcbiAgICAgIExvZ2dlci5kZWJ1ZyhcIlNldHRpbmdzIGxvYWRlZDpcIiwgdGhpcy5zZXR0aW5ncyk7XG5cbiAgICAgIC8vIEFkZCByaWJib24gaWNvblxuICAgICAgdGhpcy5yaWJib25FbCA9IHRoaXMuYWRkUmliYm9uSWNvbignZmlsZS1lZGl0JywgJ0VkaXROZXh0IFJhbmtlcicsIGFzeW5jICgpID0+IHtcbiAgICAgICAgdGhpcy5ydW5SYW5rZXJDb21tYW5kKCk7XG4gICAgICB9KTtcblxuICAgICAvLyBBZGQgc3RhdHVzIGJhciBpdGVtIChpbml0aWFsbHkgaGlkZGVuKXxuICAgICB0aGlzLnN0YXR1c0Jhckl0ZW0gPSB0aGlzLmFkZFN0YXR1c0Jhckl0ZW0oKTtcbiAgICAgIHRoaXMuc3RhdHVzQmFySXRlbS5hZGRDbGFzcygnZWRpdG5leHQtc3RhdHVzJyk7XG4gICAgICB0aGlzLnN0YXR1c0Jhckl0ZW0uc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgIFxuICAgICAvLyBSZWdpc3RlciBjb21tYW5kXG4gICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICBpZDogJ2VkaXRuZXh0LXJhbmstZmlsZXMnLFxuICAgICAgICBuYW1lOiAnUmFuayBmaWxlcyBieSBlZGl0aW5nIGVmZm9ydCcsXG4gICAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgdGhpcy5ydW5SYW5rZXJDb21tYW5kKCk7XG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgLy8gQWRkIGNvbW1hbmQgdG8gdXBkYXRlIGZyb250bWF0dGVyXG4gICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICBpZDogJ2VkaXRuZXh0LXVwZGF0ZS1mcm9udG1hdHRlcicsXG4gICAgICAgIG5hbWU6ICdVcGRhdGUgY3VycmVudCBub3RlIHdpdGggZWRpdCBzY29yZScsXG4gICAgICAgIGVkaXRvckNhbGxiYWNrOiBhc3luYyAoZWRpdG9yLCB2aWV3KSA9PiB7XG4gICAgICAgICAgYXdhaXQgdGhpcy51cGRhdGVDdXJyZW50Tm90ZUZyb250bWF0dGVyKHZpZXcpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgLy8gQWRkIHNldHRpbmdzIHRhYlxuICAgICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBFZGl0TmV4dFNldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcbiAgICAgIFxuICAgICAgTG9nZ2VyLmluZm8oJ0VkaXROZXh0IFJhbmtlciBwbHVnaW4gbG9hZGVkIHN1Y2Nlc3NmdWxseScpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgTG9nZ2VyLmVycm9yKFwiRXJyb3IgZHVyaW5nIHBsdWdpbiBsb2FkOlwiLCBlcnIpO1xuICAgICAgdGhyb3cgZXJyOyAvLyBSZS10aHJvdyB0byBsZXQgT2JzaWRpYW4gaGFuZGxlIGl0XG4gICAgfVxuICB9XG5cbiAgb251bmxvYWQoKSB7XG4gICAgTG9nZ2VyLmluZm8oJ1VubG9hZGluZyBFZGl0TmV4dCBSYW5rZXIgcGx1Z2luJyk7XG4gICAgLy8gQ2xlYXIgcmVmZXJlbmNlc1xuICAgIHRoaXMucmliYm9uRWwgPSBudWxsO1xuICAgIHRoaXMuc3RhdHVzQmFySXRlbSA9IG51bGw7XG4gIH1cbiAgXG4gIGFzeW5jIHJ1blJhbmtlckNvbW1hbmQoKSB7XG4gICAgTG9nZ2VyLmluZm8oJ1J1bm5pbmcgRWRpdE5leHQgcmFua2VyIGNvbW1hbmQuLi4nKTtcbiAgICBuZXcgTm90aWNlKCdSdW5uaW5nIEVkaXROZXh0IHJhbmtlci4uLicpO1xuICAgIFxuICAgIC8vIFNob3cgcHJvZ3Jlc3MgaW4gc3RhdHVzIGJhclxuICAgIGlmICh0aGlzLnN0YXR1c0Jhckl0ZW0pIHtcbiAgICAgIHRoaXMuc3RhdHVzQmFySXRlbS5zZXRUZXh0KCdFZGl0TmV4dDogQW5hbHl6aW5nIGZpbGVzLi4uJyk7XG4gICAgICB0aGlzLnN0YXR1c0Jhckl0ZW0uc3R5bGUuZGlzcGxheSA9ICdibG9jayc7XG4gICAgfVxuICAgIFxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgcnVuUmFua2VyKHRoaXMuYXBwLCB0aGlzLCB0aGlzLnNldHRpbmdzKTtcbiAgICAgIExvZ2dlci5kZWJ1ZyhcIlJhbmtlciBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5XCIpO1xuICAgICAgXG4gICAgICAvLyBIaWRlIHN0YXR1cyBiYXIgaXRlbVxuICAgICAgaWYgKHRoaXMuc3RhdHVzQmFySXRlbSkge1xuICAgICAgICB0aGlzLnN0YXR1c0Jhckl0ZW0uc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gU3RvcmUgcmVzdWx0cyBpbiBwbHVnaW4gaW5zdGFuY2UgZm9yIGxhdGVyIHVzZVxuICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVzdWx0cykpIHtcbiAgICAgICAgYXdhaXQgdGhpcy51cGRhdGVBbGxGcm9udG1hdHRlcihyZXN1bHRzKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gU2hvdyBvdXRwdXQgaW4gYSBuZXcgcGFuZVxuICAgICAgY29uc3QgbGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWFmKHRydWUpO1xuICAgICAgYXdhaXQgbGVhZi5vcGVuKG5ldyBFZGl0TmV4dFJlc3VsdFZpZXcobGVhZiwgcmVzdWx0cykpO1xuICAgICAgXG4gICAgICAvLyBTaG93IHN1Y2Nlc3Mgbm90aWNlIHdpdGggdG9wIGZpbGUgaW5mb1xuICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVzdWx0cykgJiYgcmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IHRvcEZpbGUgPSByZXN1bHRzWzBdO1xuICAgICAgICBjb25zdCBmaWxlTmFtZSA9IHRvcEZpbGUuZmlsZS5zcGxpdCgvW1xcL1xcXFxdLykucG9wKCk7XG4gICAgICAgIG5ldyBOb3RpY2UoYFRvcCBlZGl0IHByaW9yaXR5OiAke2ZpbGVOYW1lfSAoc2NvcmU6ICR7dG9wRmlsZS5jb21wb3NpdGVfc2NvcmUudG9GaXhlZCgxKX0pYCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBIaWRlIHN0YXR1cyBiYXIgb24gZXJyb3JcbiAgICAgIGlmICh0aGlzLnN0YXR1c0Jhckl0ZW0pIHtcbiAgICAgICAgdGhpcy5zdGF0dXNCYXJJdGVtLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgICB9XG4gICAgICBcbiAgICAgIGNvbnN0IGVycm9yTXNnID0gKGVyciBhcyBFcnJvcikubWVzc2FnZTtcbiAgICAgIExvZ2dlci5lcnJvcihcIlJhbmtlciBlcnJvcjpcIiwgZXJyKTtcbiAgICAgIG5ldyBOb3RpY2UoYEVkaXROZXh0IGVycm9yOiAke2Vycm9yTXNnfWApO1xuICAgIH1cbiAgfVxuICBcbiAgYXN5bmMgdXBkYXRlQWxsRnJvbnRtYXR0ZXIocmVzdWx0czogUmFua2VyUmVzdWx0W10pIHtcbiAgICB0cnkge1xuICAgICAgZm9yIChjb25zdCByZXN1bHQgb2YgcmVzdWx0cykge1xuICAgICAgICBhd2FpdCB0aGlzLnVwZGF0ZUZpbGVGcm9udG1hdHRlcihyZXN1bHQpO1xuICAgICAgfVxuICAgICAgTG9nZ2VyLmluZm8oYFVwZGF0ZWQgZnJvbnRtYXR0ZXIgZm9yICR7cmVzdWx0cy5sZW5ndGh9IGZpbGVzYCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJFcnJvciB1cGRhdGluZyBmcm9udG1hdHRlcjpcIiwgZXJyKTtcbiAgICB9XG4gIH1cbiAgXG4gIGFzeW5jIHVwZGF0ZUZpbGVGcm9udG1hdHRlcihyZXN1bHQ6IFJhbmtlclJlc3VsdCkge1xuICAgIHRyeSB7XG4gICAgICAvLyBGaW5kIHRoZSBmaWxlIGluIHRoZSB2YXVsdFxuICAgICAgY29uc3QgZmlsZXMgPSB0aGlzLmFwcC52YXVsdC5nZXRGaWxlcygpO1xuICAgICAgXG4gICAgICAvLyBGaXJzdCB0cnkgZGlyZWN0IHBhdGggbWF0Y2hcbiAgICAgIGxldCB0YXJnZXRGaWxlID0gZmlsZXMuZmluZChmID0+IGYucGF0aCA9PT0gcmVzdWx0LmZpbGUpO1xuICAgICAgXG4gICAgICAvLyBJZiBub3QgZm91bmQsIHRyeSBqdXN0IHRoZSBmaWxlbmFtZVxuICAgICAgaWYgKCF0YXJnZXRGaWxlKSB7XG4gICAgICAgIGNvbnN0IGZpbGVOYW1lID0gcmVzdWx0LmZpbGUuc3BsaXQoL1tcXC9cXFxcXS8pLnBvcCgpO1xuICAgICAgICB0YXJnZXRGaWxlID0gZmlsZXMuZmluZChmID0+IGYubmFtZSA9PT0gZmlsZU5hbWUpO1xuICAgICAgfVxuICAgICAgXG4gICAgICBpZiAoIXRhcmdldEZpbGUpIHtcbiAgICAgICAgTG9nZ2VyLndhcm4oYEZpbGUgbm90IGZvdW5kIGZvciBmcm9udG1hdHRlciB1cGRhdGU6ICR7cmVzdWx0LmZpbGV9YCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gUmVhZCB0aGUgZmlsZSBjb250ZW50XG4gICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZCh0YXJnZXRGaWxlKTtcbiAgICAgIFxuICAgICAgLy8gVXBkYXRlIG9yIGFkZCBmcm9udG1hdHRlclxuICAgICAgY29uc3QgbmV3Q29udGVudCA9IHRoaXMudXBkYXRlWWFtbEZyb250bWF0dGVyKGNvbnRlbnQsIHtcbiAgICAgICAgZWRpdF9zY29yZTogcmVzdWx0LmNvbXBvc2l0ZV9zY29yZSxcbiAgICAgICAgbGxtX3Njb3JlOiByZXN1bHQubGxtX3Njb3JlLFxuICAgICAgICBncmFtbWFyX3Njb3JlOiByZXN1bHQuZ3JhbW1hcl9zY29yZSxcbiAgICAgICAgcmVhZGFiaWxpdHlfc2NvcmU6IHJlc3VsdC5yZWFkYWJpbGl0eV9zY29yZVxuICAgICAgfSk7XG4gICAgICBcbiAgICAgIC8vIFdyaXRlIGJhY2sgaWYgY2hhbmdlZFxuICAgICAgaWYgKG5ld0NvbnRlbnQgIT09IGNvbnRlbnQpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQubW9kaWZ5KHRhcmdldEZpbGUsIG5ld0NvbnRlbnQpO1xuICAgICAgICBMb2dnZXIuZGVidWcoYFVwZGF0ZWQgZnJvbnRtYXR0ZXIgZm9yICR7dGFyZ2V0RmlsZS5wYXRofWApO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgTG9nZ2VyLmVycm9yKGBFcnJvciB1cGRhdGluZyBmcm9udG1hdHRlciBmb3IgJHtyZXN1bHQuZmlsZX06YCwgZXJyKTtcbiAgICB9XG4gIH1cbiAgXG4gIGFzeW5jIHVwZGF0ZUN1cnJlbnROb3RlRnJvbnRtYXR0ZXIodmlldzogYW55KSB7XG4gICAgaWYgKCF2aWV3IHx8ICF2aWV3LmZpbGUpIHtcbiAgICAgIG5ldyBOb3RpY2UoXCJObyBhY3RpdmUgZmlsZVwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgXG4gICAgdHJ5IHtcbiAgICAgIC8vIEdldCBjdXJyZW50IGZpbGVcbiAgICAgIGNvbnN0IGZpbGUgPSB2aWV3LmZpbGU7XG4gICAgICBcbiAgICAgIC8vIFJ1biByYW5rZXIganVzdCBmb3IgdGhpcyBmaWxlXG4gICAgICBjb25zdCB2YXVsdFBhdGggPSB0aGlzLmFwcC52YXVsdC5hZGFwdGVyLmdldEJhc2VQYXRoKCk7XG4gICAgICBjb25zdCBmaWxlUGF0aCA9IHBhdGguam9pbih2YXVsdFBhdGgsIGZpbGUucGF0aCk7XG4gICAgICBjb25zdCBkaXJQYXRoID0gcGF0aC5kaXJuYW1lKGZpbGVQYXRoKTtcbiAgICAgIFxuICAgICAgbmV3IE5vdGljZShgQW5hbHl6aW5nICR7ZmlsZS5uYW1lfS4uLmApO1xuICAgICAgXG4gICAgICAvLyBPdmVycmlkZSB0YXJnZXQgZm9sZGVyIHRvIG9ubHkgc2NvcmUgdGhpcyBvbmUgZmlsZVxuICAgICAgY29uc3Qgb3JpZ2luYWxGb2xkZXIgPSB0aGlzLnNldHRpbmdzLnRhcmdldEZvbGRlcjtcbiAgICAgIHRoaXMuc2V0dGluZ3MudGFyZ2V0Rm9sZGVyID0gcGF0aC5yZWxhdGl2ZSh2YXVsdFBhdGgsIGRpclBhdGgpO1xuICAgICAgXG4gICAgICAvLyBSdW4gcmFua2VyXG4gICAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgcnVuUmFua2VyKHRoaXMuYXBwLCB0aGlzLCB0aGlzLnNldHRpbmdzKTtcbiAgICAgIFxuICAgICAgLy8gUmVzdG9yZSBvcmlnaW5hbCBzZXR0aW5nXG4gICAgICB0aGlzLnNldHRpbmdzLnRhcmdldEZvbGRlciA9IG9yaWdpbmFsRm9sZGVyO1xuICAgICAgXG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShyZXN1bHRzKSAmJiByZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgLy8gRmluZCB0aGlzIGZpbGUgaW4gcmVzdWx0c1xuICAgICAgICBjb25zdCByZXN1bHQgPSByZXN1bHRzLmZpbmQociA9PiB7XG4gICAgICAgICAgY29uc3QgcmVzdWx0TmFtZSA9IHIuZmlsZS5zcGxpdCgvW1xcL1xcXFxdLykucG9wKCk7XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdE5hbWUgPT09IGZpbGUubmFtZTtcbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy51cGRhdGVGaWxlRnJvbnRtYXR0ZXIocmVzdWx0KTtcbiAgICAgICAgICBuZXcgTm90aWNlKGBVcGRhdGVkIGVkaXQgc2NvcmVzIGZvciAke2ZpbGUubmFtZX1gKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBuZXcgTm90aWNlKGBDb3VsZCBub3QgZmluZCBhbmFseXNpcyByZXN1bHRzIGZvciAke2ZpbGUubmFtZX1gKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbmV3IE5vdGljZShcIk5vIHJlc3VsdHMgcmV0dXJuZWQgZnJvbSBhbmFseXNpc1wiKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIExvZ2dlci5lcnJvcihcIkVycm9yIHVwZGF0aW5nIGN1cnJlbnQgbm90ZTpcIiwgZXJyKTtcbiAgICAgIG5ldyBOb3RpY2UoYEVycm9yOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuICB9XG4gIFxuICB1cGRhdGVZYW1sRnJvbnRtYXR0ZXIoY29udGVudDogc3RyaW5nLCBkYXRhOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogc3RyaW5nIHtcbiAgICAvLyBSZWd1bGFyIGV4cHJlc3Npb25zIGZvciBmcm9udG1hdHRlciBkZXRlY3Rpb25cbiAgICBjb25zdCB5YW1sUmVnZXggPSAvXi0tLVxcbihbXFxzXFxTXSo/KVxcbi0tLVxcbi87XG4gICAgY29uc3QgbWF0Y2ggPSBjb250ZW50Lm1hdGNoKHlhbWxSZWdleCk7XG4gICAgXG4gICAgaWYgKG1hdGNoKSB7XG4gICAgICAvLyBGcm9udG1hdHRlciBleGlzdHMsIHBhcnNlIGl0XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCB5YW1sQ29udGVudCA9IG1hdGNoWzFdO1xuICAgICAgICAvLyBCYXNpYyBZQU1MIHBhcnNpbmcvbWFuaXB1bGF0aW9uIHdpdGhvdXQgZXh0ZXJuYWwgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBmcm9udG1hdHRlciA9IHt9O1xuICAgICAgICBjb25zdCBsaW5lcyA9IHlhbWxDb250ZW50LnNwbGl0KCdcXG4nKTtcbiAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgICAgICAgY29uc3Qga2V5VmFsdWUgPSBsaW5lLnNwbGl0KCc6Jyk7XG4gICAgICAgICAgaWYgKGtleVZhbHVlLmxlbmd0aCA+PSAyKSB7XG4gICAgICAgICAgICBjb25zdCBrZXkgPSBrZXlWYWx1ZVswXS50cmltKCk7XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGtleVZhbHVlLnNsaWNlKDEpLmpvaW4oJzonKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoa2V5ICYmIHZhbHVlKSB7XG4gICAgICAgICAgICAgIGZyb250bWF0dGVyW2tleV0gPSB2YWx1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIC8vIFVwZGF0ZSB3aXRoIG5ldyBkYXRhXG4gICAgICAgIGZyb250bWF0dGVyID0geyAuLi5mcm9udG1hdHRlciwgLi4uZGF0YSB9O1xuICAgICAgICBcbiAgICAgICAgLy8gU2VyaWFsaXplIGJhY2sgdG8gWUFNTFxuICAgICAgICBsZXQgbmV3WWFtbCA9ICctLS1cXG4nO1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhmcm9udG1hdHRlcikpIHtcbiAgICAgICAgICAvLyBGb3JtYXQgbnVtYmVycyBuaWNlbHlcbiAgICAgICAgICBjb25zdCBmb3JtYXR0ZWRWYWx1ZSA9IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgPyBcbiAgICAgICAgICAgIE51bWJlci5pc0ludGVnZXIodmFsdWUpID8gdmFsdWUgOiB2YWx1ZS50b0ZpeGVkKDEpIDogXG4gICAgICAgICAgICB2YWx1ZTtcbiAgICAgICAgICBuZXdZYW1sICs9IGAke2tleX06ICR7Zm9ybWF0dGVkVmFsdWV9XFxuYDtcbiAgICAgICAgfVxuICAgICAgICBuZXdZYW1sICs9ICctLS1cXG4nO1xuICAgICAgICBcbiAgICAgICAgLy8gUmVwbGFjZSBvbGQgZnJvbnRtYXR0ZXJcbiAgICAgICAgcmV0dXJuIGNvbnRlbnQucmVwbGFjZSh5YW1sUmVnZXgsIG5ld1lhbWwpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBMb2dnZXIuZXJyb3IoXCJFcnJvciBwYXJzaW5nIGZyb250bWF0dGVyOlwiLCBlKTtcbiAgICAgICAgLy8gSWYgcGFyc2luZyBmYWlscywgYXBwZW5kIG5ldyBmcm9udG1hdHRlciBwcm9wZXJ0aWVzXG4gICAgICAgIGxldCBuZXdZYW1sID0gbWF0Y2hbMF07XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGRhdGEpKSB7XG4gICAgICAgICAgY29uc3QgZm9ybWF0dGVkVmFsdWUgPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInID8gXG4gICAgICAgICAgICBOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSA/IHZhbHVlIDogdmFsdWUudG9GaXhlZCgxKSA6IFxuICAgICAgICAgICAgdmFsdWU7XG4gICAgICAgICAgLy8gSW5zZXJ0IGJlZm9yZSB0aGUgY2xvc2luZyAtLS1cbiAgICAgICAgICBuZXdZYW1sID0gbmV3WWFtbC5yZXBsYWNlKC8tLS1cXG4kLywgYCR7a2V5fTogJHtmb3JtYXR0ZWRWYWx1ZX1cXG4tLS1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY29udGVudC5yZXBsYWNlKHlhbWxSZWdleCwgbmV3WWFtbCk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIE5vIGZyb250bWF0dGVyLCBhZGQgbmV3IG9uZVxuICAgICAgbGV0IG5ld1lhbWwgPSAnLS0tXFxuJztcbiAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGRhdGEpKSB7XG4gICAgICAgIGNvbnN0IGZvcm1hdHRlZFZhbHVlID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyA/IFxuICAgICAgICAgIE51bWJlci5pc0ludGVnZXIodmFsdWUpID8gdmFsdWUgOiB2YWx1ZS50b0ZpeGVkKDEpIDogXG4gICAgICAgICAgdmFsdWU7XG4gICAgICAgIG5ld1lhbWwgKz0gYCR7a2V5fTogJHtmb3JtYXR0ZWRWYWx1ZX1cXG5gO1xuICAgICAgfVxuICAgICAgbmV3WWFtbCArPSAnLS0tXFxuXFxuJztcbiAgICAgIHJldHVybiBuZXdZYW1sICsgY29udGVudDtcbiAgICB9XG4gIH1cblxuICBhc3luYyBsb2FkU2V0dGluZ3MoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNhdmVkRGF0YSA9IGF3YWl0IHRoaXMubG9hZERhdGEoKTtcbiAgICAgIExvZ2dlci5kZWJ1ZyhcIkxvYWRlZCBzYXZlZCBkYXRhOlwiLCBzYXZlZERhdGEpO1xuICAgICAgdGhpcy5zZXR0aW5ncyA9IE9iamVjdC5hc3NpZ24oe30sIERFRkFVTFRfU0VUVElOR1MsIHNhdmVkRGF0YSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJGYWlsZWQgdG8gbG9hZCBzZXR0aW5nczpcIiwgZXJyKTtcbiAgICAgIHRoaXMuc2V0dGluZ3MgPSB7IC4uLkRFRkFVTFRfU0VUVElOR1MgfTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBzYXZlU2V0dGluZ3MoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gICAgICBMb2dnZXIuZGVidWcoXCJTZXR0aW5ncyBzYXZlZCBzdWNjZXNzZnVsbHlcIik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBMb2dnZXIuZXJyb3IoXCJGYWlsZWQgdG8gc2F2ZSBzZXR0aW5nczpcIiwgZXJyKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFZpZXcgdG8gZGlzcGxheSByZXN1bHRzIChpbnRlcmFjdGl2ZSBkYXNoYm9hcmQpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuaW1wb3J0IHsgSXRlbVZpZXcsIFdvcmtzcGFjZUxlYWYsIFRGaWxlLCBNYXJrZG93blJlbmRlcmVyIH0gZnJvbSAnb2JzaWRpYW4nO1xuY29uc3QgVklFV19UWVBFID0gJ2VkaXRuZXh0LXJlc3VsdHMnO1xuXG5pbnRlcmZhY2UgUmFua2VyUmVzdWx0IHtcbiAgZmlsZTogc3RyaW5nO1xuICBjb21wb3NpdGVfc2NvcmU6IG51bWJlcjtcbiAgbGxtX3Njb3JlOiBudW1iZXI7XG4gIGdyYW1tYXJfc2NvcmU6IG51bWJlcjtcbiAgcmVhZGFiaWxpdHlfc2NvcmU6IG51bWJlcjtcbiAgbm90ZXM6IHN0cmluZztcbn1cblxuY2xhc3MgRWRpdE5leHRSZXN1bHRWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICByZXN1bHRzOiBSYW5rZXJSZXN1bHRbXSB8IG51bGwgPSBudWxsO1xuICByZXN1bHRUZXh0OiBzdHJpbmcgPSAnJztcbiAgaXNKc29uRGF0YTogYm9vbGVhbiA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKGxlYWY6IFdvcmtzcGFjZUxlYWYsIGRhdGE6IGFueSkge1xuICAgIHN1cGVyKGxlYWYpO1xuICAgIFxuICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICB0aGlzLnJlc3VsdHMgPSBkYXRhIGFzIFJhbmtlclJlc3VsdFtdO1xuICAgICAgdGhpcy5pc0pzb25EYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRmFsbGJhY2sgZm9yIHBsYWluIHRleHQgcmVzdWx0c1xuICAgICAgdGhpcy5yZXN1bHRUZXh0ID0gU3RyaW5nKGRhdGEpO1xuICAgICAgdGhpcy5pc0pzb25EYXRhID0gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgZ2V0Vmlld1R5cGUoKSB7XG4gICAgcmV0dXJuIFZJRVdfVFlQRTtcbiAgfVxuXG4gIGdldERpc3BsYXlUZXh0KCkge1xuICAgIHJldHVybiAnRWRpdE5leHQgRGFzaGJvYXJkJztcbiAgfVxuXG4gIGdldEljb24oKSB7XG4gICAgcmV0dXJuICdmaWxlLWVkaXQnO1xuICB9XG5cbiAgYXN5bmMgb25PcGVuKCkge1xuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRoaXMuY29udGFpbmVyRWwuY2hpbGRyZW5bMV07XG4gICAgY29udGFpbmVyLmVtcHR5KCk7XG4gICAgY29udGFpbmVyLmFkZENsYXNzKCdlZGl0bmV4dC1kYXNoYm9hcmQnKTtcbiAgICBcbiAgICAvLyBBZGQgY3VzdG9tIHN0eWxlc1xuICAgIGNvbnN0IHN0eWxlRWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpO1xuICAgIHN0eWxlRWwudGV4dENvbnRlbnQgPSBgXG4gICAgICAuZWRpdG5leHQtZGFzaGJvYXJkIHtcbiAgICAgICAgcGFkZGluZzogMjBweDtcbiAgICAgIH1cbiAgICAgIC5lZGl0bmV4dC1oZWFkZXIge1xuICAgICAgICBtYXJnaW4tYm90dG9tOiAyMHB4O1xuICAgICAgfVxuICAgICAgLmVkaXRuZXh0LXRhYmxlIHtcbiAgICAgICAgd2lkdGg6IDEwMCU7XG4gICAgICAgIGJvcmRlci1jb2xsYXBzZTogY29sbGFwc2U7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtdGFibGUgdGgge1xuICAgICAgICB0ZXh0LWFsaWduOiBsZWZ0O1xuICAgICAgICBwYWRkaW5nOiA4cHg7XG4gICAgICAgIGJvcmRlci1ib3R0b206IDJweCBzb2xpZCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcik7XG4gICAgICAgIGZvbnQtd2VpZ2h0OiBib2xkO1xuICAgICAgICBjdXJzb3I6IHBvaW50ZXI7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtdGFibGUgdGQge1xuICAgICAgICBwYWRkaW5nOiA4cHg7XG4gICAgICAgIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcik7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtZmlsZS1saW5rIHtcbiAgICAgICAgY3Vyc29yOiBwb2ludGVyO1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1hY2NlbnQpO1xuICAgICAgICB0ZXh0LWRlY29yYXRpb246IG5vbmU7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtZmlsZS1saW5rOmhvdmVyIHtcbiAgICAgICAgdGV4dC1kZWNvcmF0aW9uOiB1bmRlcmxpbmU7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtcm93LWhpZ2gge1xuICAgICAgICBiYWNrZ3JvdW5kLWNvbG9yOiByZ2JhKDI1NSwgMTAwLCAxMDAsIDAuMSk7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtcm93LW1lZGl1bSB7XG4gICAgICAgIGJhY2tncm91bmQtY29sb3I6IHJnYmEoMjU1LCAyMDAsIDAsIDAuMSk7XG4gICAgICB9XG4gICAgICAuZWRpdG5leHQtcm93LWxvdyB7XG4gICAgICAgIGJhY2tncm91bmQtY29sb3I6IHJnYmEoMTAwLCAyNTUsIDEwMCwgMC4xKTtcbiAgICAgIH1cbiAgICAgIC5lZGl0bmV4dC1iYWRnZSB7XG4gICAgICAgIGRpc3BsYXk6IGlubGluZS1ibG9jaztcbiAgICAgICAgcGFkZGluZzogMnB4IDhweDtcbiAgICAgICAgYm9yZGVyLXJhZGl1czogNHB4O1xuICAgICAgICBmb250LXNpemU6IDAuOGVtO1xuICAgICAgICBmb250LXdlaWdodDogYm9sZDtcbiAgICAgIH1cbiAgICAgIC5lZGl0bmV4dC1iYWRnZS1oaWdoIHtcbiAgICAgICAgYmFja2dyb3VuZC1jb2xvcjogcmdiYSgyNTUsIDEwMCwgMTAwLCAwLjIpO1xuICAgICAgICBjb2xvcjogI2QzMmYyZjtcbiAgICAgIH1cbiAgICAgIC5lZGl0bmV4dC1iYWRnZS1tZWRpdW0ge1xuICAgICAgICBiYWNrZ3JvdW5kLWNvbG9yOiByZ2JhKDI1NSwgMjAwLCAwLCAwLjIpO1xuICAgICAgICBjb2xvcjogI2Y1N2MwMDtcbiAgICAgIH1cbiAgICAgIC5lZGl0bmV4dC1iYWRnZS1sb3cge1xuICAgICAgICBiYWNrZ3JvdW5kLWNvbG9yOiByZ2JhKDEwMCwgMjU1LCAxMDAsIDAuMik7XG4gICAgICAgIGNvbG9yOiAjMzg4ZTNjO1xuICAgICAgfVxuICAgIGA7XG4gICAgY29udGFpbmVyLnByZXBlbmQoc3R5bGVFbCk7XG4gICAgXG4gICAgLy8gSGVhZGVyXG4gICAgY29uc3QgaGVhZGVyID0gY29udGFpbmVyLmNyZWF0ZUVsKCdkaXYnLCB7IGNsczogJ2VkaXRuZXh0LWhlYWRlcicgfSk7XG4gICAgaGVhZGVyLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ0VkaXROZXh0IERhc2hib2FyZCcgfSk7XG4gICAgXG4gICAgaWYgKHRoaXMuaXNKc29uRGF0YSAmJiB0aGlzLnJlc3VsdHMpIHtcbiAgICAgIHRoaXMucmVuZGVySW50ZXJhY3RpdmVUYWJsZShjb250YWluZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBGYWxsYmFjayB0byBwbGFpbiB0ZXh0IGRpc3BsYXlcbiAgICAgIGNvbnN0IHByZSA9IGNvbnRhaW5lci5jcmVhdGVFbCgncHJlJyk7XG4gICAgICBwcmUuc3R5bGUud2hpdGVTcGFjZSA9ICdwcmUtd3JhcCc7XG4gICAgICBwcmUuc2V0VGV4dCh0aGlzLnJlc3VsdFRleHQpO1xuICAgIH1cbiAgfVxuICBcbiAgYXN5bmMgcmVuZGVySW50ZXJhY3RpdmVUYWJsZShjb250YWluZXI6IEhUTUxFbGVtZW50KSB7XG4gICAgaWYgKCF0aGlzLnJlc3VsdHMgfHwgdGhpcy5yZXN1bHRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29udGFpbmVyLmNyZWF0ZUVsKCdwJywgeyB0ZXh0OiAnTm8gcmVzdWx0cyBmb3VuZC4nIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBcbiAgICAvLyBDcmVhdGUgdGFibGVcbiAgICBjb25zdCB0YWJsZSA9IGNvbnRhaW5lci5jcmVhdGVFbCgndGFibGUnLCB7IGNsczogJ2VkaXRuZXh0LXRhYmxlJyB9KTtcbiAgICBcbiAgICAvLyBUYWJsZSBoZWFkZXJcbiAgICBjb25zdCB0aGVhZCA9IHRhYmxlLmNyZWF0ZUVsKCd0aGVhZCcpO1xuICAgIGNvbnN0IGhlYWRlclJvdyA9IHRoZWFkLmNyZWF0ZUVsKCd0cicpO1xuICAgIFxuICAgIC8vIEFkZCBoZWFkZXJzIHdpdGggc29ydCBmdW5jdGlvbmFsaXR5XG4gICAgY29uc3QgaGVhZGVycyA9IFtcbiAgICAgIHsga2V5OiAnZmlsZScsIHRleHQ6ICdGaWxlJyB9LFxuICAgICAgeyBrZXk6ICdjb21wb3NpdGVfc2NvcmUnLCB0ZXh0OiAnU2NvcmUnIH0sXG4gICAgICB7IGtleTogJ2xsbV9zY29yZScsIHRleHQ6ICdMTE0nIH0sXG4gICAgICB7IGtleTogJ2dyYW1tYXJfc2NvcmUnLCB0ZXh0OiAnR3JhbW1hcicgfSxcbiAgICAgIHsga2V5OiAncmVhZGFiaWxpdHlfc2NvcmUnLCB0ZXh0OiAnUmVhZGFiaWxpdHknIH0sXG4gICAgICB7IGtleTogJ25vdGVzJywgdGV4dDogJ05vdGVzJyB9XG4gICAgXTtcbiAgICBcbiAgICBmb3IgKGNvbnN0IGhlYWRlciBvZiBoZWFkZXJzKSB7XG4gICAgICBjb25zdCB0aCA9IGhlYWRlclJvdy5jcmVhdGVFbCgndGgnKTtcbiAgICAgIHRoLnNldFRleHQoaGVhZGVyLnRleHQpO1xuICAgICAgdGguZGF0YXNldC5rZXkgPSBoZWFkZXIua2V5O1xuICAgICAgXG4gICAgICAvLyBBZGQgY2xpY2sgaGFuZGxlciBmb3Igc29ydGluZ1xuICAgICAgdGguYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIHRoaXMuc29ydFJlc3VsdHMoaGVhZGVyLmtleSk7XG4gICAgICAgIHRoaXMucmVmcmVzaFRhYmxlKHRhYmxlKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICBcbiAgICAvLyBUYWJsZSBib2R5XG4gICAgY29uc3QgdGJvZHkgPSB0YWJsZS5jcmVhdGVFbCgndGJvZHknKTtcbiAgICB0aGlzLnBvcHVsYXRlVGFibGVSb3dzKHRib2R5KTtcbiAgfVxuICBcbiAgcG9wdWxhdGVUYWJsZVJvd3ModGJvZHk6IEhUTUxFbGVtZW50KSB7XG4gICAgaWYgKCF0aGlzLnJlc3VsdHMpIHJldHVybjtcbiAgICBcbiAgICB0Ym9keS5lbXB0eSgpO1xuICAgIFxuICAgIGZvciAoY29uc3QgcmVzdWx0IG9mIHRoaXMucmVzdWx0cykge1xuICAgICAgY29uc3Qgcm93ID0gdGJvZHkuY3JlYXRlRWwoJ3RyJyk7XG4gICAgICBcbiAgICAgIC8vIEFkZCByb3cgY2xhc3MgYmFzZWQgb24gc2NvcmVcbiAgICAgIGlmIChyZXN1bHQuY29tcG9zaXRlX3Njb3JlID49IDcwKSB7XG4gICAgICAgIHJvdy5hZGRDbGFzcygnZWRpdG5leHQtcm93LWhpZ2gnKTtcbiAgICAgIH0gZWxzZSBpZiAocmVzdWx0LmNvbXBvc2l0ZV9zY29yZSA+PSA0MCkge1xuICAgICAgICByb3cuYWRkQ2xhc3MoJ2VkaXRuZXh0LXJvdy1tZWRpdW0nKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJvdy5hZGRDbGFzcygnZWRpdG5leHQtcm93LWxvdycpO1xuICAgICAgfVxuICAgICAgXG4gICAgICAvLyBGaWxlIGNlbGwgd2l0aCBjbGlja2FibGUgbGlua1xuICAgICAgY29uc3QgZmlsZUNlbGwgPSByb3cuY3JlYXRlRWwoJ3RkJyk7XG4gICAgICBjb25zdCBmaWxlTGluayA9IGZpbGVDZWxsLmNyZWF0ZUVsKCdhJywgeyBcbiAgICAgICAgY2xzOiAnZWRpdG5leHQtZmlsZS1saW5rJyxcbiAgICAgICAgdGV4dDogdGhpcy5nZXRGaWxlTmFtZShyZXN1bHQuZmlsZSlcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICBmaWxlTGluay5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcbiAgICAgICAgYXdhaXQgdGhpcy5vcGVuRmlsZShyZXN1bHQuZmlsZSk7XG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgLy8gU2NvcmUgd2l0aCBjb2xvcmVkIGJhZGdlXG4gICAgICBjb25zdCBzY29yZUNlbGwgPSByb3cuY3JlYXRlRWwoJ3RkJyk7XG4gICAgICBjb25zdCBzY29yZUJhZGdlID0gc2NvcmVDZWxsLmNyZWF0ZUVsKCdzcGFuJywge1xuICAgICAgICBjbHM6IGBlZGl0bmV4dC1iYWRnZSAke3RoaXMuZ2V0U2NvcmVDbGFzcyhyZXN1bHQuY29tcG9zaXRlX3Njb3JlKX1gLFxuICAgICAgICB0ZXh0OiByZXN1bHQuY29tcG9zaXRlX3Njb3JlLnRvRml4ZWQoMSlcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICAvLyBPdGhlciBtZXRyaWNzXG4gICAgICByb3cuY3JlYXRlRWwoJ3RkJywgeyB0ZXh0OiByZXN1bHQubGxtX3Njb3JlLnRvU3RyaW5nKCkgfSk7XG4gICAgICByb3cuY3JlYXRlRWwoJ3RkJywgeyB0ZXh0OiByZXN1bHQuZ3JhbW1hcl9zY29yZS50b0ZpeGVkKDEpIH0pO1xuICAgICAgcm93LmNyZWF0ZUVsKCd0ZCcsIHsgdGV4dDogcmVzdWx0LnJlYWRhYmlsaXR5X3Njb3JlLnRvRml4ZWQoMSkgfSk7XG4gICAgICByb3cuY3JlYXRlRWwoJ3RkJywgeyB0ZXh0OiByZXN1bHQubm90ZXMgfSk7XG4gICAgfVxuICB9XG4gIFxuICBzb3J0UmVzdWx0cyhrZXk6IHN0cmluZykge1xuICAgIGlmICghdGhpcy5yZXN1bHRzKSByZXR1cm47XG4gICAgXG4gICAgY29uc3QgaXNOdW1lcmljID0ga2V5ICE9PSAnZmlsZScgJiYga2V5ICE9PSAnbm90ZXMnO1xuICAgIFxuICAgIHRoaXMucmVzdWx0cy5zb3J0KChhLCBiKSA9PiB7XG4gICAgICBpZiAoaXNOdW1lcmljKSB7XG4gICAgICAgIHJldHVybiBiW2tleV0gLSBhW2tleV07IC8vIERlc2NlbmRpbmcgZm9yIG51bWVyaWNcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBTdHJpbmcoYVtrZXldKS5sb2NhbGVDb21wYXJlKFN0cmluZyhiW2tleV0pKTsgLy8gQXNjZW5kaW5nIGZvciB0ZXh0XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgXG4gIHJlZnJlc2hUYWJsZSh0YWJsZTogSFRNTEVsZW1lbnQpIHtcbiAgICBjb25zdCB0Ym9keSA9IHRhYmxlLnF1ZXJ5U2VsZWN0b3IoJ3Rib2R5Jyk7XG4gICAgaWYgKHRib2R5KSB7XG4gICAgICB0aGlzLnBvcHVsYXRlVGFibGVSb3dzKHRib2R5KTtcbiAgICB9XG4gIH1cbiAgXG4gIGdldEZpbGVOYW1lKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgcGFydHMgPSBwYXRoLnNwbGl0KC9bXFwvXFxcXF0vKTtcbiAgICByZXR1cm4gcGFydHNbcGFydHMubGVuZ3RoIC0gMV07XG4gIH1cbiAgXG4gIGdldFNjb3JlQ2xhc3Moc2NvcmU6IG51bWJlcik6IHN0cmluZyB7XG4gICAgaWYgKHNjb3JlID49IDcwKSByZXR1cm4gJ2VkaXRuZXh0LWJhZGdlLWhpZ2gnO1xuICAgIGlmIChzY29yZSA+PSA0MCkgcmV0dXJuICdlZGl0bmV4dC1iYWRnZS1tZWRpdW0nO1xuICAgIHJldHVybiAnZWRpdG5leHQtYmFkZ2UtbG93JztcbiAgfVxuICBcbiAgYXN5bmMgb3BlbkZpbGUoZmlsZVBhdGg6IHN0cmluZykge1xuICAgIHRyeSB7XG4gICAgICAvLyBGaW5kIHRoZSBmaWxlIGluIHRoZSB2YXVsdFxuICAgICAgY29uc3QgZmlsZXMgPSB0aGlzLmFwcC52YXVsdC5nZXRGaWxlcygpO1xuICAgICAgbGV0IHRhcmdldEZpbGU6IFRGaWxlIHwgbnVsbCA9IG51bGw7XG4gICAgICBcbiAgICAgIC8vIEZpcnN0IHRyeSBkaXJlY3QgcGF0aCBtYXRjaFxuICAgICAgdGFyZ2V0RmlsZSA9IGZpbGVzLmZpbmQoZiA9PiBmLnBhdGggPT09IGZpbGVQYXRoKSB8fCBudWxsO1xuICAgICAgXG4gICAgICAvLyBJZiBub3QgZm91bmQsIHRyeSB0aGUgZmlsZW5hbWVcbiAgICAgIGlmICghdGFyZ2V0RmlsZSkge1xuICAgICAgICBjb25zdCBmaWxlTmFtZSA9IHRoaXMuZ2V0RmlsZU5hbWUoZmlsZVBhdGgpO1xuICAgICAgICB0YXJnZXRGaWxlID0gZmlsZXMuZmluZChmID0+IGYubmFtZSA9PT0gZmlsZU5hbWUpIHx8IG51bGw7XG4gICAgICB9XG4gICAgICBcbiAgICAgIGlmICh0YXJnZXRGaWxlKSB7XG4gICAgICAgIC8vIE9wZW4gdGhlIGZpbGUgaW4gYSBuZXcgbGVhZlxuICAgICAgICBhd2FpdCB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhZihmYWxzZSkub3BlbkZpbGUodGFyZ2V0RmlsZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBuZXcgTm90aWNlKGBGaWxlIG5vdCBmb3VuZDogJHtmaWxlUGF0aH1gKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIExvZ2dlci5lcnJvcihcIkVycm9yIG9wZW5pbmcgZmlsZTpcIiwgZXJyKTtcbiAgICAgIG5ldyBOb3RpY2UoYEVycm9yIG9wZW5pbmcgZmlsZTogJHtlcnIubWVzc2FnZX1gKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBvbkNsb3NlKCkge1xuICAgIC8vIENsZWFuIHVwXG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFNldHRpbmdzIFRhYiBVSVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmNsYXNzIEVkaXROZXh0U2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xuICBwbHVnaW46IEVkaXROZXh0UGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IEVkaXROZXh0UGx1Z2luKSB7XG4gICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xuICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICAgIExvZ2dlci5kZWJ1ZyhcIlNldHRpbmdzIHRhYiBpbml0aWFsaXplZFwiKTtcbiAgfVxuXG4gIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgY29uc3QgeyBjb250YWluZXJFbCB9ID0gdGhpcztcbiAgICBMb2dnZXIuZGVidWcoXCJTZXR0aW5ncyB0YWIgZGlzcGxheWVkXCIpO1xuXG4gICAgY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ0VkaXROZXh0IFJhbmtlciBTZXR0aW5ncycgfSk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdPcGVuQUkgQVBJIEtleScpXG4gICAgICAuc2V0RGVzYygnUmVxdWlyZWQgdG8gcXVlcnkgR1BUIG1vZGVscycpXG4gICAgICAuYWRkVGV4dCgodGV4dCkgPT5cbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignc2stWFhYWCcpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLm9wZW5haUFwaUtleSlcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5vcGVuYWlBcGlLZXkgPSB2YWx1ZS50cmltKCk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ1B5dGhvbiBQYXRoJylcbiAgICAgIC5zZXREZXNjKCdQYXRoIHRvIFB5dGhvbiBleGVjdXRhYmxlICh3aXRoIGRlcGVuZGVuY2llcyBpbnN0YWxsZWQpJylcbiAgICAgIC5hZGRUZXh0KCh0ZXh0KSA9PlxuICAgICAgICB0ZXh0XG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCdweXRob24zJylcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MucHl0aG9uUGF0aClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5weXRob25QYXRoID0gdmFsdWUudHJpbSgpIHx8ICdweXRob24zJztcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnV2VpZ2h0cycpXG4gICAgICAuc2V0RGVzYygnVGhyZWUgbnVtYmVycyBmb3IgTExNLCBHcmFtbWFyLCBSZWFkYWJpbGl0eSB3ZWlnaHRzIChzdW0gMS4wKScpXG4gICAgICAuYWRkVGV4dCgodGV4dCkgPT5cbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignMC42IDAuMiAwLjInKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy53ZWlnaHRzLmpvaW4oJyAnKSlcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBwYXJ0cyA9IHZhbHVlLnNwbGl0KC9cXHMrLykubWFwKE51bWJlcik7XG4gICAgICAgICAgICBpZiAocGFydHMubGVuZ3RoID09PSAzICYmIHBhcnRzLmV2ZXJ5KChuKSA9PiAhaXNOYU4obikpKSB7XG4gICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLndlaWdodHMgPSBwYXJ0cyBhcyBbbnVtYmVyLCBudW1iZXIsIG51bWJlcl07XG4gICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnT3BlbkFJIE1vZGVsJylcbiAgICAgIC5zZXREZXNjKCdNb2RlbCB0byB1c2UgZm9yIHNjb3JpbmcnKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XG4gICAgICAgIHRleHQuc2V0UGxhY2Vob2xkZXIoJ2dwdC00by1taW5pJykuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MubW9kZWwpLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsID0gdmFsdWUudHJpbSgpO1xuICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ1RhcmdldCBGb2xkZXInKVxuICAgICAgLnNldERlc2MoJ1JlbGF0aXZlIHBhdGggaW5zaWRlIHZhdWx0OyBsZWF2ZSBibGFuayBmb3IgZW50aXJlIHZhdWx0JylcbiAgICAgIC5hZGRUZXh0KCh0ZXh0KSA9PlxuICAgICAgICB0ZXh0XG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCdkcmFmdHMnKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy50YXJnZXRGb2xkZXIpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MudGFyZ2V0Rm9sZGVyID0gdmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG4gIH1cbn0gIl0sIm5hbWVzIjpbIm5vcm1hbGl6ZVBhdGgiLCJzcGF3biIsIlBsdWdpbiIsIk5vdGljZSIsIkl0ZW1WaWV3IiwiUGx1Z2luU2V0dGluZ1RhYiIsIlNldHRpbmciXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFBQTtBQU1BO0FBQ0EsTUFBTSxNQUFNLENBQUE7QUFTVixJQUFBLE9BQU8sS0FBSyxDQUFDLE9BQWUsRUFBRSxHQUFHLElBQVcsRUFBQTtRQUMxQyxJQUFJLE1BQU0sQ0FBQyxLQUFLLElBQUksTUFBTSxDQUFDLEtBQUssRUFBRTtBQUNoQyxZQUFBLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQSxDQUFBLEVBQUksTUFBTSxDQUFDLE1BQU0sQ0FBSyxFQUFBLEVBQUEsT0FBTyxDQUFFLENBQUEsRUFBRSxHQUFHLElBQUksQ0FBQzs7O0FBSTNELElBQUEsT0FBTyxJQUFJLENBQUMs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
