#!/usr/bin/env python3
"""
Essay Quality Ranker
====================
Given a folder of Markdown files, assigns each file an "editing effort" score and
outputs a ranked list from highest (worst draft) to lowest (best draft) directly in the CLI.

The score is a weighted composite of:
    1. LLM Edit‑Effort (0‑100)
    2. Grammar error rate (errors per 1 000 words, scaled 0‑100)
    3. Readability gap (grade‑level above 8th grade, scaled 0‑100)

Weights default to 0.6, 0.2, 0.2 but can be changed on the CLI.

Usage
-----
$ pip install openai textstat language_tool_python python-dotenv tqdm rich
$ export OPENAI_API_KEY="sk‑..."  # or store in .env next to the script
$ python essay_quality_ranker.py path/to/obsidian/drafts

The script displays a formatted table with: filename, composite score, llm score, 
grammar score, readability score, and notes.

The heaviest operation is the LLM call. The script streams progress with tqdm
and caches results in a hidden `.cache_edit_scores` folder so you pay only once per file.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Tuple

# Check for required dependencies
required_packages = ['openai', 'textstat', 'language_tool_python', 'tqdm', 'rich']
missing_packages = []

for package in required_packages:
    try:
        __import__(package)
    except ImportError:
        missing_packages.append(package)

if missing_packages:
    print(f"Error: Missing required packages: {', '.join(missing_packages)}")
    print("\nPlease install them using:")
    print(f"pip install {' '.join(missing_packages)}")
    sys.exit(1)

# Now import the required packages
import openai
import textstat
import language_tool_python
from dotenv import load_dotenv
from tqdm import tqdm
from rich.console import Console
from rich.table import Table
from rich import box

# ------------------------------------------------------------
# Heuristic Components
# ------------------------------------------------------------

tool = language_tool_python.LanguageTool("en-US")

def grammar_error_score(text: str) -> float:
    """Return 0‑100 scaled grammar error score (higher = worse)."""
    matches = tool.check(text)
    words = max(len(text.split()), 1)
    errors_per_1k = len(matches) / words * 1000  # raw density
    # Empirically cap at density 10 => score 100
    return max(min(errors_per_1k * 10, 100), 0)

def readability_score(text: str) -> float:
    """Return 0‑100 scaled readability score based on FK grade > 8."""
    try:
        # Calculate multiple readability metrics for a more robust score
        fk_grade = textstat.flesch_kincaid_grade(text)
        flesch_score = textstat.flesch_reading_ease(text)
        
        # Convert Flesch Reading Ease (0-100) to a 0-100 score where higher means more difficult
        # (Flesch Reading Ease is reverse scaled - higher means easier)
        flesch_inverted = max(0, min(100, 100 - flesch_score))
        
        # Combine metrics (FK grade level above 8 + inverted Flesch score)
        grade_component = max(fk_grade - 8, 0) * 10  # Each grade level above 8 is worth 10 points
        
        # Calculate final score as weighted average
        final_score = (grade_component * 0.6) + (flesch_inverted * 0.4)
        
        # Ensure score is between 0-100
        return max(min(final_score, 100), 0)
    except Exception as e:
        print(f"Error calculating readability: {str(e)}")
        return 50.0  # Default to middle value on error

def llm_edit_score(text: str, model: str = "gpt-4o-mini") -> Tuple[int, str]:
    """Query OpenAI to get an edit effort score (0-100) and a short note."""
    prompt = (
        "You are an expert developmental editor. Read the draft below and evaluate its quality. "
        "Your task is to return a simple JSON object with exactly two keys:\n"
        "1. 'edit_effort': an integer from 0 to 100, where 100 means the draft needs heavy revision\n"
        "2. 'notes': a brief one-sentence explanation of the main issue with the draft\n\n"
        "Example response: {\"edit_effort\": 65, \"notes\": \"Needs clearer structure and more evidence.\"}\n\n"
        "Your response must be valid JSON and nothing else. No explanation, no markdown formatting.\n\n"
        "<draft>\n" + text + "\n</draft>"
    )
    
    try:
        # Check OpenAI version and use appropriate API call
        import pkg_resources
        openai_version = pkg_resources.get_distribution("openai").version
        is_new_api = int(openai_version.split('.')[0]) >= 1
        
        if is_new_api:
            # For OpenAI v1.0.0+
            resp = openai.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=100,
            )
            content = resp.choices[0].message.content.strip()
        else:
            # For OpenAI < v1.0.0
            resp = openai.ChatCompletion.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=100,
            )
            content = resp.choices[0].message.content.strip()
        
        # Clean up the response to ensure it's valid JSON
        # Remove markdown code block formatting if present
        if content.startswith("```json"):
            content = content[7:]
        if content.endswith("```"):
            content = content[:-3]
        
        # Remove any leading/trailing non-JSON characters
        content = content.strip()
        
        # Try to find valid JSON in the string using { } as delimiters
        if '{' in content and '}' in content:
            start = content.find('{')
            end = content.rfind('}') + 1
            content = content[start:end]
        
        data = json.loads(content)
        
        # Validate values
        edit_effort = int(data.get("edit_effort", 50))
        # Ensure it's within 0-100 range
        edit_effort = max(0, min(100, edit_effort))
        
        notes = data.get("notes", "").strip()
        if not notes:
            notes = "No specific issues noted"
            
        return edit_effort, notes
    
    except Exception as e:
        # Log the error and return fallback values
        print(f"Error parsing LLM response: {str(e)}")
        return 50, f"LLM parse error: {str(e)[:50]}"

# ------------------------------------------------------------
# Core Processing
# ------------------------------------------------------------

def composite_score(llm: float, grammar: float, readability: float, w: Tuple[float, float, float]) -> float:
    a, b, c = w
    return a * llm + b * grammar + c * readability

def process_file(path: Path, weights, cache_dir: Path, model: str):
    cached = cache_dir / (path.stem + ".json")
    if cached.exists():
        return json.loads(cached.read_text())

    text = path.read_text(encoding="utf-8", errors="ignore")
    llm, note = llm_edit_score(text, model=model)
    grammar = grammar_error_score(text)
    read = readability_score(text)
    comp = composite_score(llm, grammar, read, weights)

    result = {
        "file": str(path),
        "llm_score": llm,
        "grammar_score": grammar,
        "readability_score": read,
        "composite_score": comp,
        "notes": note,
    }
    cached.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result

# ------------------------------------------------------------
# CLI
# ------------------------------------------------------------

def main():
    load_dotenv()
    
    # Explicitly set the API key here
    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        openai.api_key = api_key
    else:
        sys.exit("OPENAI_API_KEY not set. Export it or put it in a .env file.")
    
    parser = argparse.ArgumentParser(description="Rank Markdown drafts by editing effort.")
    parser.add_argument("folder", type=Path, help="Folder containing .md files")
    parser.add_argument("--output", "-o", type=Path, help="Optional CSV output file")
    parser.add_argument("--weights", nargs=3, type=float, metavar=("LLM", "GRAM", "READ"), default=(0.6, 0.2, 0.2))
    parser.add_argument("--model", default="gpt-4o-mini", help="OpenAI model name")
    parser.add_argument("--json", action="store_true", help="Output results as JSON instead of a table")
    parser.add_argument("--exclude-folders", "-e", nargs="*", default=[], help="Subfolder names to exclude (relative to folder)")
    args = parser.parse_args()

    md_files: List[Path] = list(args.folder.glob("**/*.md"))
    # Exclude specified subfolders if any
    if args.exclude_folders:
        # Normalize exclude paths
        exclude_paths = [Path(args.folder / excl).resolve() for excl in args.exclude_folders]
        # Normalize and compare full paths
        md_files = [p for p in md_files if not any(
            str(p.resolve()).startswith(str(excl_path))
            for excl_path in exclude_paths
        )]
    if not md_files:
        sys.exit("No .md files found in the specified folder.")

    cache_dir = args.folder / ".cache_edit_scores"
    cache_dir.mkdir(exist_ok=True)

    results = []
    for fp in tqdm(md_files, desc="Scoring drafts"):
        results.append(process_file(fp, args.weights, cache_dir, args.model))

    results.sort(key=lambda r: r["composite_score"], reverse=True)

    # Output JSON if requested
    if args.json:
        # Prepare results for JSON output, using relative paths
        base_path = str(args.folder.resolve())
        for r in results:
            # Convert to relative path for Obsidian linking
            full_path = r["file"]
            if full_path.startswith(base_path):
                r["file"] = full_path[len(base_path):].lstrip('/\\')
        
        # Print the JSON output
        print(json.dumps(results))
        return

    # Output results to CLI using Rich
    console = Console()
    
    # Change the box style to include vertical column separators
    table = Table(show_header=True, header_style="bold magenta", box=box.SIMPLE)
    table.add_column("File", style="dim")
    table.add_column("Score", justify="right")
    table.add_column("LLM", justify="right")
    table.add_column("Grammar", justify="right")
    table.add_column("Readability", justify="right")
    table.add_column("Notes")
    
    for r in results:
        # Format scores
        comp_score = f"{r['composite_score']:.1f}"
        llm_score = f"{r['llm_score']}"
        grammar_score = f"{r['grammar_score']:.1f}"
        readability_score = f"{r['readability_score']:.1f}"
        
        # Extract filename from path for cleaner display
        filename = Path(r['file']).name
        
        # Determine row color based on score
        score_val = float(comp_score)
        if score_val >= 70:
            row_style = "red"
        elif score_val >= 40:
            row_style = "yellow"
        else:
            row_style = "green"
            
        table.add_row(
            filename, 
            comp_score,
            llm_score,
            grammar_score,
            readability_score,
            r['notes'],
            style=row_style
        )
    
    console.print("\n📝 Essay Quality Rankings (higher score = needs more work)\n")
    console.print(table)
    
    # Optionally save to CSV if requested
    if args.output:
        import csv
        with open(args.output, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=results[0].keys())
            writer.writeheader()
            writer.writerows(results)
        console.print(f"\nSaved rankings to {args.output.absolute()}")

if __name__ == "__main__":
    main()
