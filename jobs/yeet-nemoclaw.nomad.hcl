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
      delay          = "15s"
      delay_function = "exponential"
      max_delay      = "5m"
      unlimited      = true
    }

    task "nemoclaw" {
      driver = "raw_exec"

      config {
        command = "/usr/bin/nemoclaw"
        args    = ["run"]
      }

      env {
        HOME = "/home/icd"
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
        attempts = 10
        interval = "30m"
        delay    = "15s"
        mode     = "delay"
      }

      kill_timeout = "10s"
    }
  }
}
