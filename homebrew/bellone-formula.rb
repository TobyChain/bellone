class Bellone < Formula
  desc "本地健康节律助手：用不同的铃声提醒你和平地工作（命令行版）"
  homepage "https://github.com/TobyChain/bellone"
  url "https://github.com/TobyChain/bellone/archive/refs/tags/v0.1.0.tar.gz"
  # 发布 tag 后填入：shasum -a 256 v0.1.0.tar.gz
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.local_npm_install_args
    system "npm", "run", "build"
    libexec.install Dir["*"]
    (bin/"bellone").write <<~SH
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/dist/index.js" "$@"
    SH
    chmod 0755, bin/"bellone"
  end

  test do
    require "net/http"
    port = 3219
    pid = spawn({ "PORT" => port.to_s, "BELLONE_DATA_DIR" => testpath/"data" }, bin/"bellone")
    sleep 3
    begin
      res = Net::HTTP.get_response("127.0.0.1", "/api/status", port)
      assert_equal "200", res.code
    ensure
      Process.kill("TERM", pid)
    end
  end
end
