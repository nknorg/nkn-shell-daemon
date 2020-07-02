.PHONY: all
all:
	yarn build
	rm -rf build/linux-amd64 && pkg -t linux-x64 -o build/linux-amd64/nshd . && wget -c https://github.com/oznu/node-pty-prebuilt-multiarch/releases/download/v0.9.0/node-pty-prebuilt-multiarch-v0.9.0-node-v64-linux-x64.tar.gz -O - | tar -xz && mv build/Release/pty.node build/linux-amd64/
	rm -rf build/darwin-amd64 && pkg -t mac-x64 -o build/darwin-amd64/nshd . && wget -c https://github.com/oznu/node-pty-prebuilt-multiarch/releases/download/v0.9.0/node-pty-prebuilt-multiarch-v0.9.0-node-v64-darwin-x64.tar.gz -O - | tar -xz && mv build/Release/pty.node build/darwin-amd64/
	${MAKE} tar

.PHONY: tar
tar:
	cd build && rm -f linux-amd64.tar.gz && tar --exclude ".DS_Store" --exclude "__MACOSX" -czvf linux-amd64.tar.gz linux-amd64
	cd build && rm -f darwin-amd64.tar.gz && tar --exclude ".DS_Store" --exclude "__MACOSX" -czvf darwin-amd64.tar.gz darwin-amd64
