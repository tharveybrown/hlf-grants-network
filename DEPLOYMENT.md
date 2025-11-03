# Deploying HLF Grants Network to Replit

## 🚀 Quick Deployment Steps

### 1. Build the App Locally

```bash
npm run build
```

This creates the `dist/` folder with your production-ready React app.

### 2. Push to GitHub

```bash
git add .
git commit -m "Add Replit deployment config"
git push origin main
```

### 3. Import to Replit

1. Go to [Replit](https://replit.com)
2. Click **"Create Repl"**
3. Select **"Import from GitHub"**
4. Paste your repository URL
5. Click **"Import from GitHub"**

### 4. Install Dependencies

Once in Replit, run in the Shell:

```bash
npm install
```

### 5. Build the App (if not already built)

```bash
npm run build
```

### 6. Start the Server

Click the **"Run"** button, or run:

```bash
npm start
```

### 7. Deploy to Production

1. Click the **"Deploy"** button in Replit
2. Follow the prompts to deploy your app
3. Get your public URL!

## 🔒 Password Protection

The app is protected with password: **hlf2025**

Users will see a login screen before accessing the visualization.

## 📝 Important Files

- `server.js` - Express server that serves the built React app
- `.replit` - Replit configuration
- `dist/` - Built React app (created by `npm run build`)
- `public/grants-network-data.json` - Your network data

## ⚠️ Notes

- The free tier may sleep after inactivity (first load will be slow)
- Make sure `dist/` folder exists before running `npm start`
- Always run `npm run build` after making code changes

## 🔮 Future: Custom EIN Support

For rebuilding the network with different EINs:
1. Run `npm run build-complete-dataset -- --ein=123456789` locally
2. This creates new `grants-network-data.json`
3. Commit and push changes
4. Replit auto-deploys OR click "Deploy" again
