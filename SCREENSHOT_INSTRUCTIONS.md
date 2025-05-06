# Screenshot Instructions for EditNext Ranker Plugin

To make your plugin more appealing in the Obsidian marketplace, you should add a screenshot image following these steps:

1. **Create an assets folder** in the root of your plugin repository:
   ```
   mkdir -p editnext-plugin/assets
   ```

2. **Take a screenshot** of your plugin in action showing:
   - The results view with ranked documents
   - The sorting functionality
   - The details panel showing scores and AI-generated notes

3. **Save the screenshot** as `editnext-screenshot.png` in the assets folder

4. **Update your GitHub repository** by pushing these changes:
   ```
   git add editnext-plugin/assets/editnext-screenshot.png
   git commit -m "Add plugin screenshot for marketplace"
   git push
   ```

5. **Verify the image URL works** by checking:
   https://raw.githubusercontent.com/shreyas-makes/editnext-plugin/main/assets/editnext-screenshot.png

This screenshot will be displayed in your README and significantly improve your plugin's appeal on the Obsidian marketplace. 