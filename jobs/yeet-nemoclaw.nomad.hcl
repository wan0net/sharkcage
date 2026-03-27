job "yeet-nemoclaw" {
  type = "service"

  constraint {
    attribute = "${attr.unique.hostname}"
    value     = "yeet-01"
  }

  group "gateway" {
    count = 1

    network {
      port "web" {
        static = 8080
        to     = 30051
      }
    }

    reschedule {
      delay          = "15s"
      delay_function = "exponential"
      max_delay      = "5m"
      unlimited      = true
    }

    task "nemoclaw" {
      driver = "docker"

      config {
        image      = "ghcr.io/nvidia/openshell/cluster:0.0.13"
        privileged = true

        ports = ["web"]

        mount {
          type     = "volume"
          source   = "openshell-cluster-nemoclaw"
          target   = "/var/lib/rancher/k3s"
          readonly = false
        }

        extra_hosts = [
          "host.docker.internal:host-gateway",
          "host.openshell.internal:host-gateway",
        ]

        security_opt = [
          "label=disable",
        ]

        args = [
          "server",
          "--disable=traefik",
          "--tls-san=127.0.0.1",
          "--tls-san=localhost",
          "--tls-san=host.docker.internal",
        ]
      }

      env {
        REGISTRY_MODE     = "external"
        REGISTRY_HOST     = "ghcr.io"
        REGISTRY_INSECURE = "false"
        IMAGE_REPO_BASE   = "ghcr.io/nvidia/openshell"
        IMAGE_TAG         = "0.0.13"
      }

      resources {
        cpu    = 500
        memory = 1024
      }

      restart {
        attempts = 10
        interval = "30m"
        delay    = "15s"
        mode     = "delay"
      }

      kill_timeout = "30s"
    }
  }
}
