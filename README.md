# Streaming Subtitle Downloaders

A collection of Tampermonkey userscripts for downloading subtitles from supported streaming services.

The repository currently includes subtitle downloaders for Apple TV+, Coupang Play, Disney+, and Netflix.

## Supported services

| Service      | Script                                               | Install |
| ------------ | ---------------------------------------------------- | ------- |
| Apple TV+    | `apple-tv-plus-subtitles-downloader.user.js`         | [Install](https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/apple-tv-plus-subtitles-downloader.user.js) |
| Coupang Play | `coupang-play-subtitles-downloader.user.js`          | [Install](https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/coupang-play-subtitles-downloader.user.js) |
| Disney+      | `disney-plus-subtitles-downloader.user.js`           | [Install](https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/disney-plus-subtitles-downloader.user.js) |
| Netflix      | `netflix-subtitles-downloader.user.js`               | [Install](https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/netflix-subtitles-downloader.user.js) |

## Features

* Downloads subtitle tracks directly from supported streaming services
* Detects subtitle tracks associated with the current playback session
* Supports multiple subtitle languages when available
* Uses streaming metadata and network resources to identify subtitle tracks
* Runs directly in the browser through a userscript manager
* Does not require a separate desktop application or server

Implementation details vary by streaming service because each platform exposes playback and subtitle information differently.

## Requirements

* A browser compatible with Tampermonkey or another compatible userscript manager
* An active account for the corresponding streaming service
* Access to the content whose subtitles you want to download

## Installation

1. Install Tampermonkey or another compatible userscript manager.
2. Select the desired script from the **Supported services** table.
3. Open its **Install** link.
4. Confirm installation in the userscript manager.
5. Open the corresponding streaming service.

Automatic userscript updates are configured through each script's `@updateURL` and `@downloadURL`, which point to the corresponding raw file on the `main` branch.

Userscript managers use the `@version` value to determine whether a newer script revision is available, so the version must be increased whenever a script is updated.

## Usage

Open the supported streaming service and start playback of the desired content.

The userscript detects available subtitle resources during playback and provides the subtitle downloading functionality implemented for that service.

Because streaming services frequently change their web applications, playback APIs, manifests, and metadata formats, a script may require updates when the corresponding service changes its implementation.

## Project structure

```text
streaming-subtitle-downloaders/
├── scripts/
│   ├── apple-tv-plus-subtitles-downloader.user.js
│   ├── coupang-play-subtitles-downloader.user.js
│   ├── disney-plus-subtitles-downloader.user.js
│   └── netflix-subtitles-downloader.user.js
├── .gitattributes
├── .gitignore
└── README.md
```

## Runtime dependencies

Some scripts load third-party libraries at runtime through userscript `@require` directives.

The currently used libraries include:

* JSZip
* FileSaver / FileSaver.js

Dependency versions may differ between scripts.

## Development

Each streaming service has its own implementation because subtitle discovery depends on platform-specific behavior such as:

* playback session detection
* network request monitoring
* manifest parsing
* subtitle track discovery
* content metadata extraction
* filename generation
* download and ZIP handling

Changes to a streaming provider's web player or backend interfaces can therefore affect one downloader without affecting the others.

## License and attribution

License and author information for each downloader is defined in the userscript metadata at the beginning of the corresponding script.

Some scripts are based on or derived from existing subtitle downloader projects and include their original attribution where applicable.

Please refer to each script's metadata for the applicable license and attribution information.

## Disclaimer

These scripts are intended for personal use with content that you are authorized to access.

Streaming services may change their websites, APIs, playback systems, or terms of service at any time. Users are responsible for ensuring that their use of these scripts complies with applicable laws and the terms of the corresponding streaming service.
