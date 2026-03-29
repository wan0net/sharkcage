# Godot 4 Editor with GPU acceleration and MCP Pro support
# Intended for AI coding agents on Lenovo M920q (i7-8700T + NVIDIA RTX A2000 12GB)
# GPU passthrough is handled by NVIDIA Container Toolkit on the host.
# Usage: docker run --gpus all ... or via docker-compose with nvidia runtime

FROM ubuntu:22.04

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# ── Godot version (override at build time: --build-arg GODOT_VERSION=4.x.x) ──
ARG GODOT_VERSION=4.6.1

# ── NVIDIA runtime passthrough ────────────────────────────────────────────────
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=all

# ── Virtual display for headless / remote operation ──────────────────────────
ENV DISPLAY=:99

# ── System packages ───────────────────────────────────────────────────────────
# xvfb         – virtual framebuffer (headless display)
# libvulkan1   – Vulkan runtime (required by Godot 4)
# vulkan-tools – vkinfo / vulkaninfo utilities
# libgl1       – OpenGL fallback
# libglib2.0-0 – GLib (dependency for many GTK/GUI libs)
# wget/unzip   – used to fetch and extract the Godot binary
# curl/git     – general tooling, useful for agent workflows
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        libvulkan1 \
        vulkan-tools \
        libgl1 \
        libglib2.0-0 \
        wget \
        unzip \
        curl \
        git \
        ca-certificates \
        gnupg \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 LTS (via NodeSource) ──────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Godot 4 binary ───────────────────────────────────────────────────────────
RUN mkdir -p /opt/godot \
    && wget -q \
        "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip" \
        -O /tmp/godot.zip \
    && unzip -q /tmp/godot.zip -d /tmp/godot-extract \
    && mv /tmp/godot-extract/Godot_v${GODOT_VERSION}-stable_linux.x86_64 /opt/godot/godot \
    && chmod +x /opt/godot/godot \
    && ln -s /opt/godot/godot /usr/local/bin/godot \
    && rm -rf /tmp/godot.zip /tmp/godot-extract

# ── Directory structure ───────────────────────────────────────────────────────
# /project        – bind-mount point for the host Godot project
# /opt/godot-mcp  – bind-mount point for the MCP Pro server package
RUN mkdir -p /project /opt/godot-mcp

# ── Entrypoint ────────────────────────────────────────────────────────────────
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# MCP Pro WebSocket port
EXPOSE 6505

WORKDIR /project

ENTRYPOINT ["/entrypoint.sh"]
