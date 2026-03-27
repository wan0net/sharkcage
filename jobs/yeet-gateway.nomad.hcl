job "yeet-gateway" {
  type = "service"

  constraint {
    attribute = "${meta.role_gateway}"
    value     = "true"
  }

  group "gateway" {
    count = 1

    network {
      port "webhook" { static = 8787 }
    }

    reschedule {
      attempts  = 5
      interval  = "1h"
      delay     = "15s"
      unlimited = false
    }

    task "gateway" {
      driver = "raw_exec"

      config {
        command = "/usr/bin/openshell-sandbox"
        args    = [
          "--policy-data", "/opt/yeet/policies/gateway.yaml",
          "--", "/usr/bin/node", "/opt/yeet/gateway/dist/index.js"
        ]
      }

      env {
        SIGNAL_CLI_URL     = "http://127.0.0.1:7583"
        SIGNAL_ACCOUNT     = "${NOMAD_META_signal_account}"
        NOMAD_ADDR         = "http://10.42.10.1:4646"
        OPENROUTER_API_KEY = "${NOMAD_META_openrouter_key}"
        OPENROUTER_MODEL   = "${NOMAD_META_openrouter_model}"
        WEBHOOK_PORT       = "${NOMAD_PORT_webhook}"
        GATEWAY_DATA_DIR   = "/opt/yeet/gateway/data"
      }

      resources {
        cpu    = 200
        memory = 256
      }

      service {
        name = "yeet-gateway"
        port = "webhook"

        check {
          type     = "http"
          path     = "/health"
          interval = "30s"
          timeout  = "5s"
        }
      }

      restart {
        attempts = 5
        interval = "5m"
        delay    = "10s"
        mode     = "delay"
      }

      kill_timeout = "10s"
    }
  }
}
