# Vlog App MVP

A lightweight MVP for an AI-assisted vlog creation workflow.

## Features

- Create a project with niche, tone, runtime, aspect ratio, and resolution
- Upload multiple media files
- Extract basic metadata such as duration, resolution, and aspect ratio
- Score media by quality and storytelling potential
- Generate a simple storyboard scene flow
- View export-ready summary with suggested title, tags, and chapter structure

## Run locally

From the project directory:

```sh
npm install
npm start
```

Then open `http://localhost:3000`.

## Health check

```sh
curl http://localhost:3000/api/health
```

## Notes

This is intentionally a practical MVP and focuses on the workflow rather than full AI-generated video rendering.

Uploaded media and generated project data are stored locally and are excluded from Git.
