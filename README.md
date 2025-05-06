# EditNext Ranker for Obsidian

An Obsidian plugin that ranks your markdown files by editing effort, helping you tackle the most challenging drafts first.

## Features

- Analyzes markdown files using OpenAI and readability metrics
- Provides a ranked list of files based on editing difficulty
- Customizable weights for different assessment criteria
- Integrates directly into your Obsidian workflow

## Installation

### From Obsidian

1. Open Obsidian
2. Go to Settings > Community plugins
3. Disable Safe mode if enabled
4. Click "Browse" and search for "EditNext Ranker"
5. Install the plugin and enable it

### Manual Installation

1. Download the latest release from the [GitHub releases page](https://github.com/shreyas-makes/editnext-plugin/releases)
2. Extract the files into your Obsidian vault's `.obsidian/plugins/editnext-plugin/` folder
3. Create a `data` folder inside the `editnext-plugin` folder
4. Download the [essay-quality-ranker.py](https://raw.githubusercontent.com/shreyas-makes/editnext-plugin/main/data/essay-quality-ranker.py) script and place it in the `data` folder
5. Restart Obsidian
6. Enable the plugin in Settings > Community plugins

## Python Script Installation

This plugin requires a Python script to analyze and rank your files. There are two ways to install it:

### Option 1: Install in plugin directory (Recommended)

1. Create a `data` folder inside your `.obsidian/plugins/editnext-plugin/` directory
2. Download [essay-quality-ranker.py](https://raw.githubusercontent.com/shreyas-makes/editnext-plugin/main/data/essay-quality-ranker.py) and place it in this folder
3. The final path should be: `.obsidian/plugins/editnext-plugin/data/essay-quality-ranker.py`

### Option 2: Install in vault root

1. Download [essay-quality-ranker.py](https://raw.githubusercontent.com/shreyas-makes/editnext-plugin/main/data/essay-quality-ranker.py)
2. Place it in the root of your Obsidian vault
3. The plugin will automatically find it there

## Usage

1. Open Obsidian
2. Set up your API key and preferences in the plugin settings
3. Run the command "Rank files by editing effort" from the command palette
4. View the ranked results

## Configuration

The plugin can be configured in the Settings tab:

- **OpenAI API Key**: Required for text analysis
- **Python Path**: Path to your Python executable (defaults to 'python3')
- **Weights**: Customize the importance of LLM scoring, grammar, and readability (e.g., 0.6 0.2 0.2)
- **OpenAI Model**: Choose which model to use (default: gpt-4o-mini)
- **Target Folder**: Specify a subfolder to analyze (leave blank for entire vault)

## Dependencies

- Python 3.x
- OpenAI API key
- Required Python packages: `openai`, `csv-parse`

## Development

1. Clone the repository
2. Install dependencies with `npm install`
3. Build the plugin with `npm run build`

## Troubleshooting

### Plugin Fails to Load

If you see a "Failed to load plugin" error in Obsidian:

1. Verify the plugin is installed in the correct location: `.obsidian/plugins/editnext-plugin/`
2. Check the plugin's manifest.json has all required fields
3. Open Developer Tools (Ctrl+Shift+I or Cmd+Option+I) to see detailed error messages
4. Make sure Python is installed and accessible in your system path
5. Try disabling and re-enabling the plugin

### Python Script Not Found

If you get errors about missing Python scripts:

1. Check that the `data` folder exists in your plugin directory and contains `essay-quality-ranker.py`
2. Verify your Python path in the settings (use absolute path if necessary)
3. Install any missing Python dependencies: `pip install openai language-tool-python textstat`

### Reload After Changes

After changing settings or updating the plugin:

1. Disable and re-enable the plugin in Obsidian's Community Plugins settings
2. Or use the [Hot-Reload plugin](https://github.com/pjeby/hot-reload) for development

## License

MIT 