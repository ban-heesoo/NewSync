# NewSync

<p align="center">
<img src="https://hivicode.github.io/newsync/Cover.jpg" alt="Cover">
</p>

<details>
<summary>Screenshots</summary>
<p align="center">
<img src="https://hivicode.github.io/newsync/pvspecial.png" alt="Player Page Screenshot">
<img src="https://hivicode.github.io/newsync/pv1.png" alt="Artwork Fullscreen Screenshot 1">
<img src="https://hivicode.github.io/newsync/pv2.png" alt="Artwork Fullscreen Screenshot 2">
<img src="https://hivicode.github.io/newsync/pv3.png" alt="Artwork Fullscreen Screenshot 3">
<img src="https://hivicode.github.io/newsync/pv4.png" alt="Artwork Fullscreen Screenshot 4">
</p>
</details>

<br>

**Extension for Synchronized Lyrics on YouTube Music**

NewSync is a browser extension that brings synchronized lyrics to YouTube Music with an Apple Music-inspired interface.

</p>

## Installation

### Install from Source

<details>
<summary><b>For Chrome Users, Developers & Advanced Users</b></summary>

### Requirements:
- install [git scm](https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe)

### For Chrome, Vivaldi, Opera, and Brave

1.  **Clone or Download the Repository:**
    ```bash
    git clone https://github.com/ban-heesoo/NewSync
    ```
2.  Alternatively, you can download the latest release from [Github Releases](https://github.com/ban-heesoo/NewSync/releases/latest) and extract the zip file.
3.  **Open Extensions Page:**
    Navigate to `chrome://extensions/` (same for Vivaldi, Opera, and Brave)
4.  **Enable Developer Mode:**
    Toggle the "Developer mode" switch in the top right corner.
5.  **Load Unpacked Extension:**
    Click on "Load unpacked" and select the cloned repository folder.

### For Firefox and Zen

1.  **Clone or Download the Repository:**
    ```bash
    git clone https://github.com/ban-heesoo/NewSync
    ```
2.  Alternatively, you can download the latest release from [Github Releases](https://github.com/ban-heesoo/NewSync/releases/latest) and extract the zip file.
3.  **Open Firefox Debugging Page:**
    Navigate to `about:debugging#/runtime/this-firefox`
4.  **Load Temporary Add-on:**
    Click on "Load Temporary Add-on" and choose the `manifest.json` file from the repository folder.

</details>


### Install from Add-ons Stores (not yet updated, wait)

Safe, easy, and get auto updates. Install NewSync directly from your browser's web store.

<p float="left">
Microsoft Edge (Recommended):<br>
<a href="https://microsoftedge.microsoft.com/addons/detail/newsync/abdllbamaomfdbfiipnpljdiljojmnoe" target="_blank"><img src="https://hivicode.github.io/newsync/edge.svg" alt="Microsoft Edge Add-ons" height="60"/></a><br>
Firefox (a bit lag):<br>
<a href="https://addons.mozilla.org/en-US/firefox/addon/newsync/" target="_blank"><img src="https://hivicode.github.io/newsync/firefox.svg" alt="Firefox Add-ons" height="60"/></a>
</p>

## Updating

If you have installed the extension with cloned repository, you can simply update it by running update script in the folder where you cloned the repository:<br>
- `update.bat`(for windows) or
- `update.sh`(for linux)

## Usage

Once installed, simply open [YouTube Music](https://music.youtube.com/) and play any song. The lyrics panel will automatically be enhanced by NewSync with custom lyrics, no external API setup required (except for Gemini AI features).

-   **Quick Settings:** Access quick toggles by clicking the NewSync icon in your browser's toolbar.
-   **Full Settings:** For comprehensive customization, click **"More Settings"** from the popup to open the dedicated settings page.

## Acknowledgments

This project is inspired by and built upon the work of talented developers:

- **Base Project:** NewSync is based on the work by [@ibratabian17](https://github.com/ibratabian17). Special thanks for the foundation and inspiration.
- **Popup Style:** The popup style is inspired by the work of [@boidushya](https://github.com/boidushya), known for creating the Better Lyrics extension for YouTube Music.

We are grateful for their contributions to the open-source community.
