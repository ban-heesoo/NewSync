#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "Verifying Git Installation..."
if command -v git >/dev/null 2>&1; then
    echo "Git found!"
    echo
    # Get Git version
    git --version
    echo
else
    echo "Git not found!"
    echo
    echo "Please install Git using your package manager:"
    echo "  Ubuntu/Debian: sudo apt update && sudo apt install git"
    echo "  CentOS/RHEL:   sudo yum install git"
    echo "  Fedora:        sudo dnf install git"
    echo "  Arch:          sudo pacman -S git"
    echo "  Or visit:      https://git-scm.com/"
    echo
    exit 1
fi

echo "Repository:"
if ! git remote get-url origin >/dev/null 2>&1; then
    echo "Could not determine the remote repository."
    echo "Make sure you are in a folder with an initialized Git repository."
    echo
    exit 1
fi
git remote get-url origin
echo

echo "Current branch:"
if ! git branch --show-current >/dev/null 2>&1; then
    echo "Could not determine current branch."
fi
git branch --show-current 2>/dev/null || echo "No current branch"
echo

echo "Checking for local changes..."
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo
    echo "WARNING: You have local changes in your repository!"
    echo
    git status --short 2>/dev/null || true
    echo
    read -p "Do you want to discard all local changes? (y/N - default is No): " discard
    if [[ "$discard" =~ ^[Yy]$ ]]; then
        echo
        echo "Discarding local changes..."
        if git checkout . 2>/dev/null; then
            echo "Local changes discarded successfully!"
        else
            echo "Error discarding local changes."
            echo "You may need to resolve this manually."
            echo
            exit 1
        fi
    else
        echo
        echo "Keeping local changes. Update cancelled."
        echo "Please commit, stash, or manually resolve your changes before updating."
        echo
        exit 0
    fi
    echo
fi

echo "Checking for remote changes..."
if ! git fetch origin 2>/dev/null; then
    echo "Warning: Could not fetch from remote repository."
    echo "Note: Without a successful fetch, 'git pull' will likely fail. Please check your internet connection and remote repository configuration."
    echo
fi

echo "Updating repository..."
if git pull; then
    echo
    echo "Repository updated successfully!"
else
    echo
    echo "Error updating the repository."
    echo "Possible causes:"
    echo "- No internet connection"
    echo "- Authentication required"
    echo "- Merge conflicts"
    echo "- No remote repository configured"
    echo
    echo "You may need to resolve conflicts manually or check your credentials."
fi

echo
echo "All done!"
