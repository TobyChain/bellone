cask "bellone" do
  version "0.1.1"
  sha256 "dfcd5a53d2eb68f058be19e619bd8d68bd300e45bfb88969115a0af35c847103"

  url "https://github.com/TobyChain/bellone/releases/download/v#{version}/Bellone-#{version}-arm64.dmg"
  name "壹铃 Bellone"
  desc "本地健康节律助手：用不同的铃声提醒你和平地工作"
  homepage "https://github.com/TobyChain/bellone"

  app "Bellone.app"

  # 未签名分发：安装后清除 quarantine，避免首次被 Gatekeeper 拦
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Bellone.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/Bellone",
  ]
end
