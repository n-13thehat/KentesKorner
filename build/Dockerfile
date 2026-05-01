FROM alpine:3.19

LABEL maintainer="KenteOS Build System"
LABEL description="Builds the KenteOS bootable ISO"

# Build tools for creating a bootable Alpine-based ISO
RUN apk add --no-cache \
    alpine-sdk \
    apk-tools \
    squashfs-tools \
    xorriso \
    grub \
    grub-efi \
    mtools \
    dosfstools \
    syslinux \
    bash \
    curl \
    wget \
    unzip \
    git \
    nodejs \
    npm \
    python3 \
    py3-pip \
    xz \
    cpio \
    findutils \
    file

WORKDIR /build

COPY create-iso.sh .
COPY overlay/ overlay/

RUN chmod +x create-iso.sh

VOLUME ["/output"]

ENTRYPOINT ["/build/create-iso.sh"]
