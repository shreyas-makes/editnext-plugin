# EditNext Ranker for Obsidian

Transform your writing workflow by intelligently prioritizing your drafts. EditNext Ranker uses advanced AI to help you focus on the documents that need your attention most.

![EditNext Ranker Screenshot](https://raw.githubusercontent.com/shreyas-makes/editnext-plugin/main/assets/editnext-screenshot.png)

## Why EditNext?

- **Save time** by immediately identifying which drafts need the most work
- **Improve your writing** with concrete feedback on each document's weaknesses
- **Track your progress** as your documents improve with each editing session
- **Leverage AI insights** without leaving your Obsidian environment

## Features

- **Smart Document Analysis** using OpenAI and advanced readability metrics
- **Comprehensive Scoring System** that evaluates:
  - Overall editing effort (AI-generated)
  - Grammar and language errors
  - Readability and complexity
- **Interactive Dashboard** with sortable columns and one-click navigation
- **Frontmatter Integration** to automatically add scores to your documents
- **Customizable Weights** to emphasize the factors that matter most to you
- **Folder Targeting** to analyze specific sections of your vault
- **Exclude Folders** to skip specific subfolders from analysis
- **Dashboard as Home Page** option to see your editing priorities on startup

## 📋 How It Works

1. Select which documents to analyze (your entire vault or a specific folder)
2. EditNext processes each document through multiple analysis engines
3. View results in a beautiful, interactive dashboard sorted by editing priority
4. Click any document to open it and start editing where it matters most

## 🔧 Installation

### From Obsidian Community Plugins (Recommended)

1. Open Obsidian Settings → Community plugins
2. Disable Safe mode if needed
3. Search for "EditNext Ranker" and click Install
4. Enable the plugin

### Manual Installation

1. Download the latest release from the [GitHub releases page](https://github.com/shreyas-makes/editnext-plugin/releases)
2. Extract the files into your `.obsidian/plugins/editnext-plugin/` folder
3. Enable the plugin in Obsidian settings

## 🛠️ Setup

1. Open Settings → EditNext Ranker
2. Enter your OpenAI API key
3. Adjust other settings as needed:
   - Python path (defaults to 'python3')
   - Analysis weights (default: 0.6 0.2 0.2)
   - OpenAI model (default: gpt-4o-mini)
   - Target folder (optional)

## 🧰 Usage

### Quick Start
1. Click the EditNext icon in the ribbon or run the "Rank files by editing effort" command
2. Wait for analysis to complete (results are cached for speed)
3. Review the sorted list and begin editing your most challenging drafts

### Advanced Features
- **Custom Weights**: Adjust the importance of LLM scoring, grammar, and readability
- **Folder Targeting**: Analyze only specific folders in your vault
- **Exclude Subfolders**: Skip specific subfolders from analysis
- **Frontmatter Updates**: Automatically add editing scores to your document metadata
- **Dashboard Integration**: View and sort your documents by editing priority
- **Manual Refresh**: Re-analyze documents after making significant edits
- **Dashboard as Home**: Option to show the EditNext dashboard when opening Obsidian

## 📊 Results Explanation

EditNext provides several scores for each document:

- **Composite Score** (0-100): Higher means more editing needed
- **LLM Score** (0-100): AI assessment of overall editing effort
- **Grammar Score** (0-100): Based on grammar error density
- **Readability Score** (0-100): Based on reading complexity above 8th grade level
- **Notes**: Brief AI-generated feedback on main issues

## 🔍 Troubleshooting

### Common Issues

- **Python Script Not Found**: Make sure Python is installed and the path is correct in settings
- **API Key Issues**: Verify your OpenAI API key is valid and has sufficient quota
- **Missing Python Packages**: Run `pip install openai textstat language_tool_python python-dotenv tqdm rich`
- **Dashboard Not Loading**: Try refreshing the view or restarting Obsidian
- **Frontmatter Not Updating**: Check file permissions and vault settings

Need more help? Visit our [GitHub Issues page](https://github.com/shreyas-makes/editnext-plugin/issues).

## 💻 Development

Contributions welcome! See our [GitHub repository](https://github.com/shreyas-makes/editnext-plugin) for development instructions.

## 📝 License

MIT 