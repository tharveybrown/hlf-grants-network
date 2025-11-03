# Gemini Code Assistant Context

This document provides context for the HLF Grants Network Visualization project.

## Project Overview

This project is a web-based data visualization tool that displays the Hidden Leaf Foundation's (HLF) grant network. It's built with React, TypeScript, D3.js, and Tailwind CSS, and uses Vite for development and building.

The application has two main parts:

1.  **Data Processing Pipeline:** A set of Node.js scripts that download, parse, and filter grant data from the IRS.
2.  **Frontend Application:** A React application that visualizes the processed data as an interactive network graph.

### Architecture

The data pipeline works in two stages:

1.  `scripts/build-complete-grants-dataset.ts`: This script downloads bulk 990-PF XML data from the IRS for specified years. It then parses these XML files to extract grant information, creating a comprehensive dataset of foundations and the organizations they fund. This is a long-running process that can take several hours. The output is a large JSON file (`data/complete-grants-dataset.json`).

2.  `scripts/filter-hlf-network.ts`: This script takes the complete dataset and filters it to create a smaller, focused dataset for the HLF network. It identifies HLF, its grantees (from a manually maintained CSV file), and other foundations that fund the same grantees. The output is a much smaller JSON file (`public/grants-network-data.json`) that is loaded by the frontend.

The frontend is a single-page application built with React and Vite. It fetches the filtered network data and uses D3.js to render an interactive, force-directed graph. Users can click on nodes to see more details, drag nodes to rearrange the layout, and zoom in and out.

## Building and Running

### Prerequisites

- Node.js and npm

### Installation

```bash
npm install
```

### Development

To run the development server:

```bash
npm run dev
```

This will start the Vite development server, and the application will be available at `http://localhost:5173`.

### Data Processing

To build the complete grants dataset from IRS data:

```bash
npm run build-complete-dataset
```

**Note:** This is a very long-running process.

To filter the complete dataset for the HLF network:

```bash
npm run filter-hlf
```

### Production Build

To build the application for production:

```bash
npm run build
```

This will create a `dist` directory with the production-ready assets.

## Development Conventions

*   **Styling:** The project uses Tailwind CSS for styling. Utility classes are preferred over custom CSS.
*   **State Management:** Component-level state is managed with React hooks (`useState`, `useEffect`). There is no global state management library like Redux or Zustand.
*   **Data Fetching:** Data is fetched using the `fetch` API.
*   **Linting:** The project uses ESLint for code quality. Run the linter with `npm run lint`.
*   **Typing:** The project is written in TypeScript. All new code should be strongly typed.
