from dataclasses import dataclass, field


@dataclass
class HassioServiceInfo:
    config: dict
    name: str
    slug: str
    uuid: str = ""
    context: dict = field(default_factory=dict)
