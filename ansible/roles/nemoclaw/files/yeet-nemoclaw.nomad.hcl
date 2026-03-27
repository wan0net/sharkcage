job "yeet-nemoclaw" {
  type = "service"

  constraint {
    attribute = "${attr.unique.hostname}"
    value     = "yeet-01"
  }

  group "gateway" {
    count = 1

    network {
      port "web" { static = 8080 }
    }

    reschedule {
      attempts  = 5
      interval  = "1h"
      delay     = "15s"
      unlimited = false
    }

    task "nemoclaw" {
      driver = "raw_exec"

      config {
        command = "/usr/local/bin/nemoclaw"
        args    = ["run"]
      }

      env {
        HOME = "/home/runner"
      }

      resources {
        cpu    = 300
        memory = 512
      }

      service {
        name = "yeet-nemoclaw"
        port = "web"

        check {
          type     = "http"
          path     = "/"
          port     = "web"
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
