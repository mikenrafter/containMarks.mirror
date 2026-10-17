{
  description = "ContainMarks TypeScript development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # Live Firefox sessions for the Marionette tests and README captures.
    firefox-addon-live = {
      url = "github:mikenrafter/firefox-addon-live";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, flake-utils, firefox-addon-live }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        # Node, vanilla Firefox (FIREFOX_BINARY), Xvfb, ffmpeg, ImageMagick and
        # xdotool, plus the firefox-addon-live link that package.json uses.
        devShells.default = firefox-addon-live.lib.devShell {
          inherit pkgs;
          shellHook = ''
            echo "ContainMarks dev shell ready: npm install && npm run build && npm test"
            echo "Live Firefox tests: npm run test:live   README captures: npm run capture:readme"
          '';
        };
      });
}
